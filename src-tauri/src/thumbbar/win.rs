//! Win32 side of the thumbnail buttons: `ITaskbarList3` buttons on the main window and a window
//! subclass that receives their clicks and the "TaskbarButtonCreated" message. Everything runs on
//! the main thread, which owns the window.

use std::cell::RefCell;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass, TaskbarList,
    THB_FLAGS, THB_ICON, THB_TOOLTIP, THBF_DISABLED, THBF_ENABLED, THBF_HIDDEN, THBN_CLICKED,
    THUMBBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, CreateIcon, DestroyIcon, HICON, IsWindowVisible, MSGFLT_ALLOW,
    RegisterWindowMessageW, SM_CXSMICON, WM_COMMAND, WM_DPICHANGED, WM_NCDESTROY,
    WM_SETTINGCHANGE,
};
use windows::core::w;

use super::glyphs::{self, Glyph};
use super::{Button, CLICK_EVENT, Click, ThumbState, button_views, tooltip_utf16};

const SUBCLASS_ID: usize = 0x7468_756d;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Id of the "TaskbarButtonCreated" message (0 until registered).
static BUTTON_CREATED: AtomicU32 = AtomicU32::new(0);

thread_local! {
    static BAR: RefCell<Option<Bar>> = const { RefCell::new(None) };
}

struct Bar {
    hwnd: HWND,
    taskbar: Option<ITaskbarList3>,
    /// The buttons are on the current taskbar button.
    added: bool,
    state: Option<ThumbState>,
    icons: Option<Icons>,
    /// The icons before the last change, kept until the next one: Explorer may still draw them.
    retired: Option<Icons>,
}

impl Bar {
    /// Makes the icons for the window's DPI and the taskbar theme if either changed.
    fn refresh_icons(&mut self) -> bool {
        let size = icon_size(self.hwnd);
        let light = light_taskbar();
        if self
            .icons
            .as_ref()
            .is_some_and(|i| i.size == size && i.light == light)
        {
            return false;
        }
        match Icons::create(size, light) {
            Some(icons) => {
                self.retired = self.icons.replace(icons);
                true
            }
            None => false,
        }
    }
}

struct Icons {
    size: u32,
    light: bool,
    handles: [HICON; Glyph::ALL.len()],
}

impl Icons {
    fn create(size: u32, light: bool) -> Option<Self> {
        let color = if light {
            glyphs::DARK_GLYPH
        } else {
            glyphs::LIGHT_GLYPH
        };
        let mut icons = Self {
            size,
            light,
            handles: [HICON::default(); Glyph::ALL.len()],
        };
        for glyph in Glyph::ALL {
            match create_icon(&glyphs::render(glyph, size, color), size) {
                Ok(icon) => icons.handles[glyph.index()] = icon,
                Err(e) => {
                    log::warn!("thumbnail buttons: cannot create icon: {e}");
                    return None;
                }
            }
        }
        Some(icons)
    }
}

impl Drop for Icons {
    fn drop(&mut self) {
        for icon in self.handles {
            if !icon.is_invalid() {
                // SAFETY: the icons were created by `create_icon` and are owned by this set.
                let _ = unsafe { DestroyIcon(icon) };
            }
        }
    }
}

/// An icon from RGBA pixels (straight alpha, top to bottom).
fn create_icon(rgba: &[u8], size: u32) -> windows::core::Result<HICON> {
    let bgra: Vec<u8> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|&[r, g, b, a]| [b, g, r, a])
        .collect();
    // The monochrome mask (1 bit per pixel, rows padded to 16 bits) is unused with an alpha channel.
    let mask = vec![0u8; size.div_ceil(16) as usize * 2 * size as usize];
    let size = size as i32;
    // SAFETY: both buffers hold `size` rows in the formats given.
    unsafe { CreateIcon(None, size, size, 1, 32, mask.as_ptr(), bgra.as_ptr()) }
}

/// Small icon size for the window's DPI (16 px at 100 %).
fn icon_size(hwnd: HWND) -> u32 {
    // SAFETY: plain queries on a valid window.
    let size = unsafe {
        let dpi = GetDpiForWindow(hwnd);
        GetSystemMetricsForDpi(SM_CXSMICON, if dpi == 0 { 96 } else { dpi })
    };
    size.clamp(16, 64) as u32
}

/// Whether the taskbar, and with it the thumbnail preview, uses the light theme.
fn light_taskbar() -> bool {
    let mut value = 0u32;
    let mut len = size_of::<u32>() as u32;
    // SAFETY: `value` and `len` describe a DWORD buffer.
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("SystemUsesLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some((&raw mut value).cast()),
            Some(&raw mut len),
        )
    };
    result == ERROR_SUCCESS && value != 0
}

fn with_bar<R>(f: impl FnOnce(&mut Bar) -> R) -> Option<R> {
    BAR.with(|cell| cell.try_borrow_mut().ok()?.as_mut().map(f))
}

pub fn attach(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let hwnd = match window.hwnd() {
        // Passed on as a number: window handles are not `Send`.
        Ok(hwnd) => hwnd.0 as usize,
        Err(e) => {
            log::warn!("thumbnail buttons: no window handle: {e}");
            return;
        }
    };
    let _ = app.run_on_main_thread(move || install(HWND(hwnd as *mut _)));
}

pub fn set_state(app: &AppHandle, state: Option<ThumbState>) {
    let _ = app.run_on_main_thread(move || {
        if with_bar(|bar| bar.state = state).is_some() {
            push();
        }
    });
}

fn install(hwnd: HWND) {
    // SAFETY: called on the window's thread with a valid window handle.
    unsafe {
        // The webview has normally set up COM on this thread already; this only makes sure.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let message = RegisterWindowMessageW(w!("TaskbarButtonCreated"));
        BUTTON_CREATED.store(message, Ordering::Relaxed);
        // Lets Explorer reach the window even when the app runs elevated.
        let _ = ChangeWindowMessageFilterEx(hwnd, message, MSGFLT_ALLOW, None);
        let _ = ChangeWindowMessageFilterEx(hwnd, WM_COMMAND, MSGFLT_ALLOW, None);
        if !SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0).as_bool() {
            log::warn!("thumbnail buttons: cannot subclass the window");
            return;
        }
    }
    BAR.with(|cell| {
        *cell.borrow_mut() = Some(Bar {
            hwnd,
            taskbar: None,
            added: false,
            state: None,
            icons: None,
            retired: None,
        })
    });
    // A visible window got its taskbar button before the subclass was there to hear about it.
    // SAFETY: plain query on a valid window.
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        button_created();
    }
}

/// The window has a new taskbar button (first shown, back from the tray, Explorer restarted).
fn button_created() {
    // SAFETY: COM is initialized on this thread (see `install`).
    let taskbar = unsafe { CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) }
        .and_then(|taskbar| unsafe { taskbar.HrInit() }.map(|()| taskbar));
    let taskbar = match taskbar {
        Ok(taskbar) => Some(taskbar),
        Err(e) => {
            log::warn!("thumbnail buttons: no taskbar: {e}");
            None
        }
    };
    with_bar(|bar| {
        bar.taskbar = taskbar;
        bar.added = false;
    });
    push();
}

/// Sends the buttons to the taskbar: adds them on a new taskbar button, updates them after that.
fn push() {
    let prepared = with_bar(|bar| {
        let taskbar = bar.taskbar.clone()?;
        bar.refresh_icons();
        let icons = bar.icons.as_ref()?;
        let buttons = button_views(bar.state.as_ref()).map(|view| THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: view.button.id(),
            iBitmap: 0,
            hIcon: icons.handles[view.glyph.index()],
            szTip: tooltip_utf16(view.tooltip),
            dwFlags: if view.hidden {
                THBF_HIDDEN
            } else if view.enabled {
                THBF_ENABLED
            } else {
                THBF_DISABLED
            },
        });
        Some((taskbar, bar.hwnd, buttons, !bar.added))
    })
    .flatten();
    let Some((taskbar, hwnd, buttons, add)) = prepared else {
        return;
    };
    // Outside the borrow: the calls talk to Explorer and may dispatch messages to this window.
    // SAFETY: valid window handle and button array; the icons outlive the call (see `retired`).
    let result = unsafe {
        if add {
            // Added before means the created message came after the first try: update instead.
            taskbar
                .ThumbBarAddButtons(hwnd, &buttons)
                .or_else(|_| taskbar.ThumbBarUpdateButtons(hwnd, &buttons))
        } else {
            taskbar.ThumbBarUpdateButtons(hwnd, &buttons)
        }
    };
    match result {
        Ok(()) => {
            with_bar(|bar| bar.added = true);
        }
        // No taskbar button yet (hidden window): the created message brings the next try.
        Err(e) => log::debug!("thumbnail buttons: not set: {e}"),
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    let created = BUTTON_CREATED.load(Ordering::Relaxed);
    match msg {
        WM_COMMAND if (wparam.0 >> 16) & 0xFFFF == THBN_CLICKED as usize => {
            if let Some(button) = Button::from_id((wparam.0 & 0xFFFF) as u32) {
                if let Some(app) = APP.get() {
                    let _ = app.emit(CLICK_EVENT, Click { button: button.name() });
                }
                // Handled here, so menu handlers further down never mistake it for a menu id.
                return LRESULT(0);
            }
        }
        // New DPI or theme: icons in the new size or color.
        WM_DPICHANGED | WM_SETTINGCHANGE => {
            if with_bar(Bar::refresh_icons) == Some(true) {
                push();
            }
        }
        WM_NCDESTROY => {
            // SAFETY: removes the subclass installed in `install`.
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) };
            BAR.with(|cell| {
                if let Ok(mut bar) = cell.try_borrow_mut() {
                    bar.take();
                }
            });
        }
        _ if created != 0 && msg == created => button_created(),
        _ => {}
    }
    // SAFETY: forwards the message to the next handler of this window.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}
