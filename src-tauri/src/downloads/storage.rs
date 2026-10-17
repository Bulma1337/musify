//! Disk side of the downloads folder: sizes and moving everything to another folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoveProgress {
    pub moved_bytes: u64,
    pub total_bytes: u64,
    pub moved_files: u64,
    pub total_files: u64,
    pub done: bool,
}

/// Total size of all files below `dir` (0 when it does not exist).
pub fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Files below `dir` as (relative path, size).
fn collect_files(base: &Path, dir: &Path, out: &mut Vec<(PathBuf, u64)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_files(base, &path, out)?;
        } else if kind.is_file()
            && let Ok(rel) = path.strip_prefix(base)
        {
            out.push((rel.to_path_buf(), entry.metadata()?.len()));
        }
    }
    Ok(())
}

fn same_or_nested(a: &Path, b: &Path) -> bool {
    let a = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let b = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    a.starts_with(&b) || b.starts_with(&a)
}

/// Moves a file; across drives (where `rename` fails) it is copied and the source deleted.
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to)?;
    if let Err(e) = fs::remove_file(from) {
        let _ = fs::remove_file(to);
        return Err(e);
    }
    Ok(())
}

/// Removes empty directories below `dir` (keeping `dir` itself).
fn remove_empty_dirs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            remove_empty_dirs(&entry.path());
            let _ = fs::remove_dir(entry.path());
        }
    }
}

/// Moves all files of `old` to `new`, keeping the relative layout. If anything fails, files that
/// were already moved go back, so the downloads never end up split across two folders.
pub fn move_dir(
    old: &Path,
    new: &Path,
    progress: &mut dyn FnMut(MoveProgress),
) -> Result<(), String> {
    if new.as_os_str().is_empty() {
        return Err("no folder given".into());
    }
    fs::create_dir_all(new).map_err(|e| format!("cannot create the folder: {e}"))?;
    if same_or_nested(old, new) {
        return Err("the new folder must be separate from the current one".into());
    }
    let mut files = Vec::new();
    if old.is_dir() {
        collect_files(old, old, &mut files).map_err(|e| format!("cannot read the folder: {e}"))?;
    }
    let total_bytes: u64 = files.iter().map(|(_, size)| size).sum();
    let total_files = files.len() as u64;
    // Existing files in the target would be overwritten by a copy; refuse instead.
    if let Some((rel, _)) = files.iter().find(|(rel, _)| new.join(rel).exists()) {
        return Err(format!("the target already contains {}", rel.display()));
    }

    let mut moved: Vec<&PathBuf> = Vec::new();
    let mut moved_bytes = 0;
    progress(MoveProgress {
        moved_bytes,
        total_bytes,
        moved_files: 0,
        total_files,
        done: false,
    });
    for (rel, size) in &files {
        let to = new.join(rel);
        let result = to
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| move_file(&old.join(rel), &to));
        if let Err(e) = result {
            for rel in moved.iter().rev() {
                let _ = move_file(&new.join(rel), &old.join(rel));
            }
            remove_empty_dirs(new);
            return Err(format!("cannot move {}: {e}", rel.display()));
        }
        moved.push(rel);
        moved_bytes += size;
        progress(MoveProgress {
            moved_bytes,
            total_bytes,
            moved_files: moved.len() as u64,
            total_files,
            done: false,
        });
    }
    remove_empty_dirs(old);
    progress(MoveProgress {
        moved_bytes,
        total_bytes,
        moved_files: total_files,
        total_files,
        done: true,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    #[test]
    fn moves_files_and_reports_progress() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        write(&old.join("Home/A/B/01 x.flac"), 100);
        write(&old.join("Home/A/B/cover.jpg"), 20);
        write(&old.join(".partial/abc.part"), 5);

        let mut seen = Vec::new();
        move_dir(&old, &new, &mut |p| seen.push(p)).unwrap();

        assert_eq!(fs::read(new.join("Home/A/B/01 x.flac")).unwrap().len(), 100);
        assert!(new.join("Home/A/B/cover.jpg").is_file());
        assert!(new.join(".partial/abc.part").is_file());
        assert!(!old.join("Home").exists(), "emptied folders are removed");
        let last = seen.last().unwrap();
        assert!(last.done);
        assert_eq!(
            (last.moved_bytes, last.total_bytes, last.moved_files),
            (125, 125, 3)
        );
        assert!(
            seen.windows(2)
                .all(|w| w[0].moved_bytes <= w[1].moved_bytes)
        );
        assert_eq!(dir_size(&new), 125);
    }

    #[test]
    fn rejects_nested_or_identical_targets() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        write(&old.join("a.flac"), 1);
        assert!(move_dir(&old, &old, &mut |_| {}).is_err());
        assert!(move_dir(&old, &old.join("inner"), &mut |_| {}).is_err());
        assert!(move_dir(&old, root.path(), &mut |_| {}).is_err());
        assert!(old.join("a.flac").is_file());
    }

    #[test]
    fn refuses_to_overwrite_and_leaves_everything_in_place() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old");
        let new = root.path().join("new");
        write(&old.join("a/1.flac"), 10);
        write(&old.join("a/2.flac"), 10);
        write(&new.join("a/2.flac"), 99);
        let err = move_dir(&old, &new, &mut |_| {}).unwrap_err();
        assert!(err.contains("already contains"), "{err}");
        assert!(old.join("a/1.flac").is_file() && old.join("a/2.flac").is_file());
        assert_eq!(fs::read(new.join("a/2.flac")).unwrap().len(), 99);
    }

    #[test]
    fn a_missing_source_folder_is_an_empty_move() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join("new");
        move_dir(&root.path().join("nothing"), &new, &mut |_| {}).unwrap();
        assert!(new.is_dir());
    }

    #[test]
    fn dir_size_counts_nested_files() {
        let root = tempfile::tempdir().unwrap();
        write(&root.path().join("a/b/c.bin"), 30);
        write(&root.path().join("d.bin"), 12);
        assert_eq!(dir_size(root.path()), 42);
        assert_eq!(dir_size(&root.path().join("missing")), 0);
    }
}
