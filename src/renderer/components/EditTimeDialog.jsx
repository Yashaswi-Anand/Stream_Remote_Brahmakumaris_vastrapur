import React, { useState } from 'react';
import { Button, Modal, Toggle } from './ui.jsx';
import { DEFAULT_STREAM_TIME, localTimeZone } from '../util.js';

function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The stream runs every day at one time, so only the time and an on/off switch are asked for.
 * The rest of the schedule is fixed: daily from today, this PC's time zone, start automatically.
 */
export default function EditTimeDialog({ schedule, act, onClose }) {
  const timeZone = schedule.timeZone || localTimeZone();
  const [time, setTime] = useState(schedule.time || DEFAULT_STREAM_TIME);
  const [enabled, setEnabled] = useState(schedule.info.configured ? schedule.enabled : true);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!time) {
      setErrors(['Choose a start time.']);
      return;
    }
    setSaving(true);
    const res = await act('saveSchedule', {
      enabled,
      date: todayIn(timeZone),
      time,
      timeZone,
      repeat: 'daily',
      selectedDays: [],
      streamingMode: schedule.streamingMode || 'zoom_and_youtube',
      autoStart: true,
      requireConfirmation: false,
    });
    setSaving(false);
    if (res?.ok) onClose();
    else setErrors(res?.errors?.length ? res.errors : [res?.error || 'Could not save the schedule.']);
  };

  return (
    <Modal
      title="Edit Time"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={saving} onClick={save}>
            Save schedule
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Daily start time</span>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <small className="muted">The stream starts automatically every day at this time.</small>
      </label>
      <div className="toggles">
        <Toggle label="Schedule enabled" checked={enabled} onChange={setEnabled} />
      </div>
      {errors.length > 0 && (
        <div className="banner banner-danger">
          <div>
            {errors.map((e) => (
              <span key={e}>{e}</span>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
