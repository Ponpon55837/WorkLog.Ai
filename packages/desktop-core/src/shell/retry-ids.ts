/**
 * The id the repair page must send with "retry". One id stays valid while the page polls, so a button the user is about to
 * press never goes stale; it is replaced only when it is used or when the state it belongs to changes.
 */
export class RetryIdIssuer {
  private readonly newId: () => string;
  private id: string;

  constructor(newId: () => string) {
    this.newId = newId;
    this.id = newId();
  }

  /** The id to show; the same one until `consume` or `rotate`. */
  current(): string {
    return this.id;
  }

  /** True once for the current id; the id is replaced at the same time, so a repeated or old id is refused. */
  consume(candidate: string): boolean {
    if (candidate !== this.id) return false;
    this.id = this.newId();
    return true;
  }

  /** The state changed (a start finished, the owner moved): ids handed out before are void. */
  rotate(): void {
    this.id = this.newId();
  }
}
