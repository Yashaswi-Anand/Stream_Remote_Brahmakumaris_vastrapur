'use strict';

/**
 * Window classes and control-name patterns used to drive the Zoom desktop client.
 * Zoom renames controls between releases, so every target lists several case-insensitive regexes,
 * tried in order. Users can override any key through `zoom.labelOverrides` in config.json.
 */
const DEFAULT_LABELS = {
  homeWindowClass: '^ZPPTMainFrmWndClassEx$',
  meetingWindowClass: 'ConfMultiTabContentWndClass|ZPContentViewWndClass|ZPConfWnd|VideoFrameWnd|ZoomMeetingWnd',
  meetingWindowTitle: '^Zoom( Workplace)?( -)? ?Meeting|^Zoom Webinar',
  previewWindowClass: '^VideoPreviewWndClass$',
  shareToolbarClass: 'ZPFloatToolbarClass|ShareToolbar|zShareFloat|ZPToolBarParentWnd|ZPShareCtrlWnd',
  shareDialogClass: '^ZPShareEntranceClass$',
  leaveDialogClass: '^zLeaveWndClass$',

  // Text labels read with Windows text recognition (Zoom 7.x draws these controls itself).
  previewStart: ['^Start$', '^Join$'],
  moreButton: ['^More$'],
  liveOnYouTube: ['^Live on YouTube$', '^YouTube$'],
  liveStreamMenu: ['^Live stream(ing)?$', '^Live on$', '^Live$', '^Livestream$'],
  liveIndicator: ['^LIVE$', '^Live$'],
  stopLiveStream: ['^Stop Live Stream$', '^Stop live stream$', '^Stop [Ll]ivestream$', '^Stop Live$', '^End Live Stream$', '^End [Ll]ivestream$'],

  shareButton: ['^Share$', '^Share Screen$'],
  screenTile: ['^Screen( \\d+)?$', '^Desktop( \\d+)?$', '^Entire screen$'],
  shareSound: ['^Share sound$', '^Share audio$', '^Share computer sound$'],
  shareConfirm: ['^Share$'],
  stopShare: ['^Stop share$', '^Stop sharing$'],
  // Sharing toolbar → More. Zoom shows the "Enable…" wording once annotation is already off for others.
  disableAnnotation: ['^Disable annotation for others$', '^Disable participants annotation$', '^Disable attendee annotation$', '^Disable annotation$'],
  annotationDisabled: ['^Enable annotation for others$', '^Enable participants annotation$', '^Enable attendee annotation$', '^Enable annotation$'],

  leaveButton: ['^End$', '^Leave$'],
  endForAll: ['^End meeting for all$', '^End Meeting for All$'],
  leaveMeeting: ['^Leave meeting$', '^Leave Meeting$'],

  goLiveBrowserButton: ['^Go Live!?$'],
};

function getLabels(overrides) {
  const labels = { ...DEFAULT_LABELS };
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in DEFAULT_LABELS)) continue;
      const valid = Array.isArray(value) ? value.every(isValidRegex) : isValidRegex(value);
      if (valid) labels[key] = value;
    }
  }
  return labels;
}

function isValidRegex(source) {
  if (typeof source !== 'string' || !source) return false;
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

module.exports = { DEFAULT_LABELS, getLabels, isValidRegex };
