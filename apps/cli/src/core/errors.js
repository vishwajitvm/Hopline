/** The other side couldn't prove it knows the transfer code (or the data was tampered with). */
export class AuthError extends Error {
  name = 'AuthError';
}

/** The other side sent something that doesn't follow the Hopline protocol. */
export class ProtocolError extends Error {
  name = 'ProtocolError';
}

/** The TCP connection ended while we were waiting for data. */
export class ConnectionClosedError extends Error {
  name = 'ConnectionClosedError';
  constructor(message = 'The other device closed the connection.') {
    super(message);
  }
}
