// Step-by-step BIOS/UEFI "power on at a set time" guides. Menu names differ between models and BIOS
// versions, so each guide lists the usual path plus the names the setting goes by.

export const BIOS_GUIDES = [
  {
    id: 'lenovo_think',
    name: 'Lenovo ThinkCentre / ThinkStation / ThinkPad',
    key: 'F1 (ThinkPad: press Enter at the logo, then F1)',
    availability: 'ThinkCentre and ThinkStation desktops have it. Many ThinkPad laptops do not.',
    steps: [
      'Restart the PC and press F1 repeatedly as soon as the Lenovo logo appears (or use "Restart into BIOS" above).',
      'Open the Power menu (on some models: Config → Power).',
      'Select Automatic Power On.',
      'Set Wake Up on Alarm to Daily Event (use User Defined to choose weekdays).',
      'Set Alarm Time to the power-on time shown on this page.',
      'If present, set "Enhanced Power Saving Mode" / "After Power Loss" so it does not block wake-up (Enhanced Power Saving: Disabled).',
      'Press F10 → Yes to save and exit.',
    ],
    names: ['Automatic Power On', 'Wake Up on Alarm', 'Alarm Time', 'Alarm Date'],
  },
  {
    id: 'lenovo_consumer',
    name: 'Lenovo IdeaPad / Yoga / Legion / Lenovo V',
    key: 'F2 (or Fn+F2), or the Novo button (small pinhole) → BIOS Setup',
    availability: 'Most IdeaPad, Yoga and Legion laptops have NO timed power-on. Check once; if it is missing, use one of the alternatives below.',
    steps: [
      'Shut down. Press the Novo button (small hole or button near the power key) and choose BIOS Setup, or press F2 repeatedly while it starts.',
      'Open the Configuration tab.',
      'Look for Automatic Power On / Wake on RTC. If it exists: set it to every day and the power-on time shown on this page.',
      'If it does not exist, look for "Power On With AC Attach" (some models): enable it to use the smart-plug method below.',
      'Press F10 → Yes to save and exit.',
    ],
    names: ['Automatic Power On', 'Wake on RTC', 'Power On With AC Attach', 'Flip to Start (lid open only)'],
  },
  {
    id: 'dell',
    name: 'Dell (Latitude, OptiPlex, Precision, Vostro, some Inspiron)',
    key: 'F2 (tap at the Dell logo)',
    availability: 'Business models have it. On laptops it usually works only on AC power (charger connected).',
    steps: [
      'Restart and tap F2 at the Dell logo (or use "Restart into BIOS" above).',
      'Open Power Management (older BIOS: Power).',
      'Select Auto On Time.',
      'Choose Every Day, Weekdays or Select Days, then set the hour and minute to the power-on time shown on this page.',
      'Desktops: set Deep Sleep Control to Disabled, otherwise Auto On does not work from shut down.',
      'Click Apply, then Exit (the PC restarts).',
    ],
    names: ['Auto On Time', 'Auto On', 'Deep Sleep Control'],
  },
  {
    id: 'hp',
    name: 'HP (EliteBook, ProBook, ZBook, EliteDesk, ProDesk)',
    key: 'F10 (or Esc, then F10)',
    availability: 'Business models have it. Consumer HP (Pavilion, Victus, Envy) usually do not.',
    steps: [
      'Restart and press F10 repeatedly (or Esc → F10).',
      'Open Advanced → BIOS Power-On (older models: Advanced → Power-On Options).',
      'Tick the days (or all days) and set Time to the power-on time shown on this page.',
      'Main → Save Changes and Exit (older BIOS: File → Save Changes and Exit).',
    ],
    names: ['BIOS Power-On', 'Power-On Time', 'Power-On Options'],
  },
  {
    id: 'asus_board',
    name: 'ASUS desktop motherboard',
    key: 'Del (or F2)',
    availability: 'Almost all ASUS desktop boards have it. ASUS laptops usually do not.',
    steps: [
      'Restart and press Del repeatedly. Press F7 for Advanced Mode.',
      'Advanced → APM Configuration.',
      'Set ErP Ready to Disabled.',
      'Set Power On By RTC to Enabled.',
      'Set RTC Alarm Date (Days) to 0 / Every Day, then the hour, minute and second to the power-on time shown on this page.',
      'Press F10 → OK to save and exit.',
    ],
    names: ['Power On By RTC', 'RTC Alarm', 'ErP Ready'],
  },
  {
    id: 'msi_board',
    name: 'MSI desktop motherboard',
    key: 'Del',
    availability: 'Almost all MSI desktop boards have it.',
    steps: [
      'Restart and press Del repeatedly. Press F7 for Advanced Mode.',
      'Settings → Advanced → Power Management Setup: set ErP Ready to Disabled.',
      'Settings → Advanced → Wake Up Event Setup: set Resume By RTC Alarm to Enabled.',
      'Set Date (of month) to 0 / Every Day and the time to the power-on time shown on this page.',
      'Press F10 → Yes to save and exit.',
    ],
    names: ['Resume By RTC Alarm', 'Wake Up Event Setup', 'ErP Ready'],
  },
  {
    id: 'gigabyte_board',
    name: 'Gigabyte / AORUS desktop motherboard',
    key: 'Del',
    availability: 'Almost all Gigabyte desktop boards have it.',
    steps: [
      'Restart and press Del repeatedly. Press F2 for Advanced Mode.',
      'Settings → Platform Power: set ErP to Disabled.',
      'Set Resume by Alarm to Enabled.',
      'Set Wake up day to 0 (every day) and Wake up hour / minute to the power-on time shown on this page.',
      'Press F10 → Yes to save and exit.',
    ],
    names: ['Resume by Alarm', 'Wake up day', 'ErP'],
  },
  {
    id: 'asrock_board',
    name: 'ASRock desktop motherboard',
    key: 'F2 or Del',
    availability: 'Most ASRock desktop boards have it.',
    steps: [
      'Restart and press F2 or Del repeatedly.',
      'Advanced → ACPI Configuration.',
      'Set Deep Sleep to Disabled.',
      'Set RTC Alarm Power On to Enabled and the time to the power-on time shown on this page (daily).',
      'Press F10 → Yes to save and exit.',
    ],
    names: ['RTC Alarm Power On', 'Deep Sleep'],
  },
  {
    id: 'acer',
    name: 'Acer laptop',
    key: 'F2',
    availability: 'Most Acer laptops have NO timed power-on. Check once; if it is missing, use an alternative below.',
    steps: [
      'Restart and press F2 repeatedly at the Acer logo.',
      'Check the Main and Power tabs for Wake on RTC / Power on by RTC.',
      'If present: enable it and set the power-on time shown on this page.',
      'Press F10 → Yes to save and exit.',
    ],
    names: ['Wake on RTC', 'Power on by RTC'],
  },
  {
    id: 'generic',
    name: 'Other / not sure',
    key: 'Del, F2, F10, F12 or Esc (shown briefly at start-up), or "Restart into BIOS" above',
    availability: 'Desktop PCs almost always have it; home laptops often do not.',
    steps: [
      'Open BIOS setup with "Restart into BIOS" above, or press the start-up key shown on the logo screen.',
      'Look in the Power, Advanced, ACPI or Power Management menus for one of the setting names below.',
      'Enable it, choose every day, and set the power-on time shown on this page.',
      'If there is an ErP / EuP / Deep Sleep / Deep S5 option, set it to Disabled (it blocks timed power-on).',
      'Save and exit (usually F10).',
    ],
    names: ['Power On By RTC', 'Resume By Alarm', 'RTC Alarm', 'Wake on RTC', 'Auto Power On', 'Automatic Power On', 'BIOS Power-On', 'Auto On Time'],
  },
];

// Placeholder strings that motherboards report when the PC builder did not fill in the maker.
const PLACEHOLDER = /^(|to be filled by o\.?e\.?m\.?|system manufacturer|default string|not applicable|oem|o\.e\.m\.)$/i;

const BOARD_GUIDES = [
  [/asus/i, 'asus_board', 'ASUS'],
  [/micro-star|^msi/i, 'msi_board', 'MSI'],
  [/gigabyte|aorus/i, 'gigabyte_board', 'Gigabyte'],
  [/asrock/i, 'asrock_board', 'ASRock'],
];

/**
 * Picks the BIOS guide for the PC this app runs on, from Windows' own hardware data:
 * the PC maker/model first, then (for desktops or unbranded PCs) the motherboard maker.
 * Returns { id, reason } — reason says in plain words what was detected.
 * pcType: Win32_ComputerSystem.PCSystemType (2 = laptop).
 */
export function detectGuide(info) {
  if (!info || info.error) return { id: 'generic', reason: 'The PC details could not be read, so general steps are shown.' };
  const maker = String(info.maker || '').trim();
  const board = String(info.boardMaker || '').trim();
  const family = `${info.family || ''} ${info.model || ''}`;
  const laptop = Number(info.pcType) === 2;
  const kind = laptop ? 'laptop' : 'PC';

  if (/lenovo/i.test(maker)) {
    return /think/i.test(family)
      ? { id: 'lenovo_think', reason: `Lenovo Think ${kind} detected (${family.trim()}).` }
      : { id: 'lenovo_consumer', reason: `Lenovo consumer ${kind} detected (${family.trim()}).` };
  }
  if (/dell/i.test(maker)) return { id: 'dell', reason: `Dell ${kind} detected (${info.model || ''}).` };
  if (/hewlett|^hp\b/i.test(maker)) return { id: 'hp', reason: `HP ${kind} detected (${info.model || ''}).` };
  if (/acer/i.test(maker)) return { id: 'acer', reason: `Acer ${kind} detected (${info.model || ''}).` };

  // Brand laptops from other makers (ASUS, MSI, Samsung, Microsoft Surface…) rarely have a timed power-on.
  if (laptop && !PLACEHOLDER.test(maker)) return { id: 'generic', reason: `${maker} laptop detected. Laptops of this brand rarely have a timed power-on; general steps are shown.` };

  // Desktops and self-built PCs: the motherboard maker decides the BIOS menus.
  for (const source of [maker, board]) {
    if (PLACEHOLDER.test(source)) continue;
    const hit = BOARD_GUIDES.find(([re]) => re.test(source));
    if (hit) return { id: hit[1], reason: `${hit[2]} motherboard detected (${info.boardProduct || board || maker}).` };
  }
  const shown = !PLACEHOLDER.test(maker) ? maker : !PLACEHOLDER.test(board) ? board : 'unknown maker';
  return { id: 'generic', reason: `${shown} ${kind} detected. No specific guide for it; general steps are shown.` };
}

/** Guide id only (see detectGuide). */
export function guessGuide(info) {
  return detectGuide(info).id;
}

/** "HH:MM" a few minutes before an ISO time, in this PC's local time (BIOS clocks use local time). */
export function powerOnTimeBefore(iso, minutes = 5) {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) - minutes * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
