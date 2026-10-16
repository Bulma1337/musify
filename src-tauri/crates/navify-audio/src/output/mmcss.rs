//! MMCSS ("Pro Audio") registration for audio threads (Windows).

use std::cell::RefCell;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Threading::{AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW};
use windows::core::w;

/// Registers the current thread with the MMCSS "Pro Audio" task; reverts on drop.
pub(crate) struct MmcssGuard(HANDLE);

impl MmcssGuard {
    /// `None` if the service refused (the thread keeps its normal priority).
    pub fn pro_audio() -> Option<Self> {
        let mut task_index = 0u32;
        // SAFETY: valid null-terminated task name and out pointer.
        unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) }.ok().map(MmcssGuard)
    }
}

impl Drop for MmcssGuard {
    fn drop(&mut self) {
        // SAFETY: handle returned by AvSetMmThreadCharacteristicsW on this thread.
        let _ = unsafe { AvRevertMmThreadCharacteristics(self.0) };
    }
}

thread_local! {
    static THREAD_GUARD: RefCell<Option<MmcssGuard>> = const { RefCell::new(None) };
}

/// Registers the calling thread (a backend-owned callback thread) for its whole lifetime; the
/// registration is reverted by the thread-local destructor when the thread exits. Idempotent.
pub(crate) fn register_current_thread() {
    THREAD_GUARD.with(|g| {
        if let Ok(mut g) = g.try_borrow_mut()
            && g.is_none()
        {
            *g = MmcssGuard::pro_audio();
        }
    });
}
