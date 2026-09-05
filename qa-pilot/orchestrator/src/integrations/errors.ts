/**
 * A tracker said no, in words a person can act on: a rejected key, an unknown team, a
 * field the project does not accept. The route turns it into a 400 on connect and a 502
 * on filing; anything else thrown by a client is a bug here, not a message for the user.
 */
export class TrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerError";
  }
}
