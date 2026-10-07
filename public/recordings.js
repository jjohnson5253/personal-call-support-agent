/** Files remain on the Node server; the browser only requests authenticated playback. */
export function renderRecordings(container, recordings, onDelete, onRetry) {
  container.querySelectorAll('audio').forEach((player) => player.pause());
  container.replaceChildren();
  if (!recordings.length) {
    const empty = document.createElement('p');
    empty.className = 'helper';
    empty.textContent = 'No recorded calls yet.';
    container.append(empty);
    return;
  }
  for (const recording of recordings) {
    const card = document.createElement('article');
    card.className = 'recording-card';
    const heading = document.createElement('h3');
    heading.textContent = recording.company;
    const info = document.createElement('p');
    info.className = 'helper';
    info.textContent = `${new Date(recording.createdAt).toLocaleString()} · ${recording.status === 'ready' ? `${Math.floor(recording.duration / 60)}m ${Math.round(recording.duration % 60)}s · ${(recording.bytes / 1048576).toFixed(1)} MB` : recording.status}`;
    const name = document.createElement('p');
    name.className = 'helper recording-path';
    name.textContent = recording.filename;
    card.append(heading, info, name);
    const actions = document.createElement('div');
    actions.className = 'recording-actions';
    if (recording.status === 'ready') {
      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'none';
      player.src = `/api/recordings/${recording.id}/audio`;
      player.setAttribute('aria-label', `Play recorded call with ${recording.company}`);
      card.append(player);
      const download = document.createElement('a');
      download.className = 'text-button';
      download.textContent = 'Download MP3';
      download.href = `${player.src}?download=1`;
      download.download = recording.filename;
      actions.append(download);
    } else {
      const message = document.createElement('p');
      message.className = 'helper';
      message.textContent =
        recording.message ||
        'Waiting for Twilio to finish processing. Keep this server and tunnel running after the call.';
      card.append(message);
      if ((recording.status === 'failed' || recording.status === 'waiting') && recording.callSid) {
        const retry = document.createElement('button');
        retry.className = 'text-button';
        retry.textContent = 'Retry download';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          retry.textContent = 'Downloading…';
          try {
            await onRetry(recording.id);
          } finally {
            retry.disabled = false;
            retry.textContent = 'Retry download';
          }
        });
        actions.append(retry);
      }
    }
    if (recording.status === 'ready' || recording.status === 'failed') {
      const remove = document.createElement('button');
      remove.className = 'text-button';
      remove.textContent = 'Delete local recording';
      remove.addEventListener('click', () => onDelete(recording.id));
      actions.append(remove);
    }
    card.append(actions);
    container.append(card);
  }
}
