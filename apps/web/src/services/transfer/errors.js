/** The data channel went away (network drop). Work pauses and resumes on the next channel. */
export class ChannelLostError extends Error {
  name = 'ChannelLostError';
  constructor() {
    super('The connection was interrupted.');
  }
}

/** The session ended for good. */
export class StoppedError extends Error {
  name = 'StoppedError';
  constructor(reason = 'The session ended.') {
    super(reason);
  }
}

/** A user (on either side) cancelled this file. */
export class CancelledError extends Error {
  name = 'CancelledError';
  constructor() {
    super('Cancelled');
  }
}
