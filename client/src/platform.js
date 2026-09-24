// True on macOS. Used to pick the right modifier key for a shortcut (Cmd vs.
// Ctrl, see CommandPalette.jsx) and to label it correctly in the UI (the
// Search button hint in App.jsx's sidebar/topbar).
export const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
