function encodeDates(dates) {
  if (!dates.length) return [];
  const sorted = [...dates].sort();
  const ranges = [];
  let start = sorted[0];
  let count = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z');
    const curr = new Date(sorted[i] + 'T00:00:00Z');
    if (Math.round((curr - prev) / 86400000) === 1) {
      count++;
    } else {
      ranges.push(start + '/' + count);
      start = sorted[i];
      count = 1;
    }
  }
  ranges.push(start + '/' + count);
  return ranges;
}

function decodeDates(encoded) {
  const dates = [];
  for (const entry of encoded) {
    const slash = entry.indexOf('/');
    const start = slash === -1 ? entry : entry.slice(0, slash);
    const count = slash === -1 ? 1 : parseInt(entry.slice(slash + 1), 10);
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid range');
    const d = new Date(start + 'T00:00:00Z');
    if (isNaN(d.getTime())) throw new Error('Invalid date');
    for (let i = 0; i < count; i++) {
      if (dates.length >= 366) throw new Error('Too many dates');
      dates.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return dates;
}

function encodeAvailability(slots, startHour, endHour) {
  const numSlots = (endHour - startHour) * 2;
  const numBytes = Math.ceil(numSlots / 8);
  const dateMap = new Map();
  for (const slot of slots) {
    const pipe = slot.indexOf('|');
    const date = slot.slice(0, pipe);
    const [h, m] = slot.slice(pipe + 1).split(':').map(Number);
    const idx = (h - startHour) * 2 + (m >= 30 ? 1 : 0);
    if (idx < 0 || idx >= numSlots) continue;
    if (!dateMap.has(date)) dateMap.set(date, new Uint8Array(numBytes));
    dateMap.get(date)[Math.floor(idx / 8)] |= (1 << (idx % 8));
  }
  const result = [];
  for (const [date, bytes] of [...dateMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    result.push(date + ':' + btoa(String.fromCharCode(...bytes)));
  }
  return result;
}

function decodeAvailability(encoded, startHour, endHour) {
  const numSlots = (endHour - startHour) * 2;
  const slots = [];
  for (const entry of encoded) {
    const colon = entry.indexOf(':');
    const date = entry.slice(0, colon);
    let bytes;
    try {
      const str = atob(entry.slice(colon + 1));
      bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    } catch { continue; }
    for (let idx = 0; idx < numSlots; idx++) {
      if (bytes[Math.floor(idx / 8)] & (1 << (idx % 8))) {
        const h = startHour + Math.floor(idx / 2);
        const m = (idx % 2) * 30;
        slots.push(date + '|' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
      }
    }
  }
  return slots;
}
