# CLI

> Code: `apps/cli` · Diagrams: [09-cli-transfer-sequence.mmd](../diagrams/09-cli-transfer-sequence.mmd),
> [10-cli-key-derivation.mmd](../diagrams/10-cli-key-derivation.mmd)

Send files and folders between two computers on the same network. It needs no server and no account, and every
byte is end-to-end encrypted. One small dependency: the audited `@noble/curves` library for the key exchange.

## Install

```bash
npm run cli -- --help          # run from the repo
npm install -g ./apps/cli      # or install a global `hopline` command
```

## Usage

```
hopline send <file|folder>... [--port <n>]
hopline receive <code> [--out <dir>] [--host <ip:port>] [--yes]
```

| Option                        | Meaning                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `-o, --out <dir>`             | Where to save (default: a new `Hopline <date time>` folder per transfer)   |
| `--host <ip:port>`            | Skip discovery and connect to the sender directly (the sender prints this) |
| `--port <n>`                  | Port the sender listens on (default: random free port)                     |
| `-y, --yes`                   | Accept without asking (needed when stdin isn't a terminal)                 |
| `-h, --help`, `-v, --version` | Help, version                                                              |

Example session:

```
$ hopline send ./photos report.pdf

Hopline · ready to send 3 file(s), 12.4 MB

  Code: 22-poppy-coyote-radar

On the other computer, run:
  hopline receive 22-poppy-coyote-radar
If it can't find this computer, add: --host 192.168.1.35:62255
```

```
$ hopline receive 22-poppy-coyote-radar --out ~/Downloads
Looking for the sender on your network…

192.168.1.35 wants to send 3 file(s), 12.4 MB:
  photos/beach.jpg (4.1 MB)
  ...
Accept these files? [Y/n]
Receiving ████████████████████████ 100%  12.4 MB / 12.4 MB  54.2 MB/s
✔ Received 3 file(s), 12.4 MB in 229 ms.
```

## How it works

1. **Code**: `NN-word-word-word`. The number (the _nameplate_) is public and used for discovery. The three words
   (256³ ≈ 16.7 million combinations) are secret and never sent over the network. An unused code expires after
   30 minutes.
2. **Discovery**: the sender broadcasts `{ app, v, nameplate, port }` over UDP port 41899 every second, to each
   interface's broadcast address, `255.255.255.255` and `127.0.0.1`.
3. **Handshake: CPace (a PAKE)** on the ristretto255 curve, via the audited `@noble/curves` library. Both sides
   derive a curve point from the code and two fresh nonces, exchange key shares and end up with the same key
   **only if they used the same code**. Each connection allows exactly one guess, and a recorded handshake
   can't be brute-forced offline.
4. **Key confirmation**: the receiver sends an encrypted `HELLO`; the sender answers with the encrypted file list.
   A wrong code can't produce either.
5. **Transfer**: files stream in order as AES-256-GCM-encrypted 256 KiB chunks, with backpressure on the network
   and the disk.
6. **Saving**: each file goes to a new hidden temporary file (created exclusively) and is moved into place only
   once complete, never overwriting an existing file (you get `name (1).ext` instead).

Wire format details: [protocols.md](protocols.md#cli-wire-protocol-v2).

## Safety rules for received files

- **A new folder per transfer** by default (`Hopline 2026-11-07 18-30-12`), so a sender can never touch your
  existing files, dotfiles or startup folders. `--out` chooses another folder.
- Every path from the sender is untrusted: `..`/`.` segments are rejected, absolute paths become relative,
  characters invalid on Windows and control/escape characters become `_`, invisible and right-to-left override
  characters are removed, and Windows reserved names (`CON`, `NUL`, `COM1`…, `COM¹`–`COM³`, `LPT¹`–`LPT³`, `CONIN$`, `CONOUT$`) get a `_` prefix.
- Writing through a symbolic link inside the output folder is refused; a final check keeps every path inside it.
- The prompt lists up to 20 files and **warns about programs/scripts and hidden files**. Only `--yes` skips it.

## Wrong codes, impostors and collisions

- Only real wrong-code attempts count; after **5** the sender stops. Junk connections (port scanners, garbage)
  are dropped without counting, and at most 4 handshakes run at once.
- Two transfers on one LAN may share a nameplate, and an impostor could announce yours. The receiver simply
  tries the next sender (up to 10): an impostor without the code can't complete the handshake.

## Programmatic use

The commands are plain async functions, which is how the tests drive them:

```js
import { sendFiles } from './src/commands/send.js';
import { receiveFiles } from './src/commands/receive.js';

const sending = sendFiles(['./photos'], {
  quiet: true,
  discovery: false,
  onReady: ({ code, port }) => {
    /*…*/
  },
});
await receiveFiles(code, { host: `127.0.0.1:${port}`, outDir: './out', autoAccept: true, quiet: true });
```

## Folder layout

```
apps/cli/
├── bin/hopline.js            Executable: runs cli.js, prints errors, sets exit code
├── src/
│   ├── cli.js                Argument parsing (node:util parseArgs), help, command table
│   ├── commands/
│   │   ├── send.js           Listen, announce, authenticate, stream files
│   │   └── receive.js        Discover, authenticate, confirm, write files safely
│   ├── core/
│   │   ├── crypto.js         CPace (ristretto255), HKDF, AES-256-GCM FrameCipher
│   │   ├── handshake.js      Cleartext greeting + key derivation
│   │   ├── framing.js        Length-prefixed frames, FrameReader, backpressure helpers
│   │   ├── messages.js       Message types, encrypted read/write helpers
│   │   ├── discovery.js      UDP announce / discover
│   │   ├── transfer-code.js  Generate and parse codes
│   │   ├── wordlist.js       256 words
│   │   └── errors.js         AuthError, ProtocolError, ConnectionClosedError
│   └── utils/                files (collect, sanitize, unique names), safe-write (SafeFileWriter, no-overwrite commit;
│                             shared with the desktop Direct mode), network, terminal (colors, progress, prompt)
└── test/                     core.test.js (units), transfer.test.js (real transfers over localhost)
```

Set `HOPLINE_DEBUG=1` to print stack traces on errors, and `NO_COLOR=1` to disable colors.
