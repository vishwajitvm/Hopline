import { useRef, useState } from 'react';
import { Icon } from '../common/Icon.jsx';

const MAX_DROPPED_FILES = 10_000;

/** Reads every file inside a dropped folder, keeping relative paths ("album/2024/a.jpg"). */
async function walkEntry(entry, out) {
  if (out.length >= MAX_DROPPED_FILES) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: entry.fullPath.replace(/^\/+/, '') });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

async function itemsFromDrop(dataTransfer) {
  const entries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (entries.length === 0) return Array.from(dataTransfer.files);
  const out = [];
  for (const entry of entries) await walkEntry(entry, out);
  return out;
}

export function Dropzone({ onFiles, disabled = false }) {
  const filesInput = useRef(null);
  const folderInput = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  const submit = (items) => {
    setError('');
    if (items.length > 0) onFiles(items.slice(0, MAX_DROPPED_FILES));
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    try {
      submit(await itemsFromDrop(event.dataTransfer));
    } catch {
      setError("Couldn't read some of the dropped items. Try the Choose buttons instead.");
    }
  };

  const fromInput = (input, withPaths) => {
    const files = Array.from(input.files ?? []);
    submit(withPaths ? files.map((file) => ({ file, path: file.webkitRelativePath || file.name })) : files);
    input.value = '';
  };

  return (
    <div>
      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}${disabled ? ' dropzone--disabled' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <Icon name="upload" size={28} />
        <strong>
          {disabled ? 'Reconnecting… files will send once you’re back' : 'Drop files or folders here'}
        </strong>
        <div className="dropzone-actions">
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => filesInput.current?.click()}
          >
            <Icon name="file" size={16} /> Choose files
          </button>
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => folderInput.current?.click()}
          >
            <Icon name="folder" size={16} /> Choose a folder
          </button>
        </div>
        <input ref={filesInput} type="file" multiple hidden onChange={(e) => fromInput(e.target, false)} />
        <input
          ref={folderInput}
          type="file"
          hidden
          webkitdirectory=""
          directory=""
          onChange={(e) => fromInput(e.target, true)}
        />
      </div>
      {error && <p className="hint hint--warning">{error}</p>}
    </div>
  );
}
