import { Emitter } from '../../utils/emitter.js';
import { ChannelLostError } from './errors.js';

/**
 * A stable handle over the main data channel that can be swapped out after a reconnect.
 *
 * Events: 'message' (string | ArrayBuffer), 'drain' (the send buffer fell to the low-water mark).
 */
export class ChannelPort extends Emitter {
  #channel = null;
  #lowWaterBytes;

  constructor({ lowWaterBytes }) {
    super();
    this.#lowWaterBytes = lowWaterBytes;
  }

  get isOpen() {
    return this.#channel?.readyState === 'open';
  }

  get bufferedAmount() {
    return this.#channel?.bufferedAmount ?? 0;
  }

  attach(channel) {
    this.detach();
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.#lowWaterBytes;
    channel.addEventListener('message', this.#onMessage);
    channel.addEventListener('bufferedamountlow', this.#onDrain);
  }

  detach() {
    const channel = this.#channel;
    if (!channel) return;
    channel.removeEventListener('message', this.#onMessage);
    channel.removeEventListener('bufferedamountlow', this.#onDrain);
    this.#channel = null;
  }

  sendJson(message) {
    if (!this.isOpen) throw new ChannelLostError();
    this.#channel.send(JSON.stringify(message));
  }

  /** Best effort: drops the message if the channel is down (used for courtesy messages). */
  trySendJson(message) {
    try {
      this.sendJson(message);
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(bytes) {
    if (!this.isOpen) throw new ChannelLostError();
    this.#channel.send(bytes);
  }

  #onDrain = () => this.emit('drain');

  #onMessage = (event) => this.emit('message', event.data);
}
