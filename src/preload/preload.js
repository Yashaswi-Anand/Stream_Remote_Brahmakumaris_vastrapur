'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// The renderer gets a fixed set of named actions only; no Node.js, filesystem or raw IPC access.
contextBridge.exposeInMainWorld('zsa', {
  getState: invoke('state:get'),
  onState: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  openZoom: invoke('zoom:open'),
  locateZoom: invoke('zoom:locate'),
  zoomDiagnostics: invoke('zoom:diagnostics'),
  startStream: invoke('stream:start'),
  endStream: invoke('stream:end'),
  cancel: invoke('stream:cancel'),
  confirmLive: invoke('stream:confirmLive'),
  shareImage: invoke('share:image'),
  shareScreen: invoke('share:screen'),
  stopShare: invoke('share:stop'),
  dismissError: invoke('workflow:dismissError'),
  chooseImageFolder: invoke('images:chooseFolder'),
  pickRandomImage: invoke('images:pickRandom'),
  chooseImage: invoke('images:chooseImage'),
  refreshImages: invoke('images:refresh'),
  updateSettings: invoke('settings:update'),
  saveSchedule: invoke('schedule:save'),
  setScheduleEnabled: invoke('schedule:setEnabled'),
  deleteSchedule: invoke('schedule:delete'),
  wakeCheck: invoke('schedule:wakeCheck'),
  wakeTest: invoke('power:wakeTest'),
  cancelWakeTest: invoke('power:cancelWakeTest'),
  hibernateUntilStream: invoke('power:hibernate'),
  powerInfo: invoke('power:info'),
  openWindowsPage: invoke('power:open'),
  restartToBios: invoke('power:restartToBios'),
  respondSchedule: invoke('schedule:respond'),
  checkUpdates: invoke('updates:check'),
  openDownload: invoke('updates:openDownload'),
  uninstall: invoke('app:uninstall'),
  cleanup: invoke('app:cleanup'),
  remotePair: invoke('remote:pair'),
  remoteSetEnabled: invoke('remote:setEnabled'),
  remoteUnpair: invoke('remote:unpair'),
  clearLogs: invoke('logs:clear'),
  openLogFolder: invoke('logs:openFolder'),
});
