export class RetryIdIssuer {
  private readonly newId: () => string;
  private id: string;

  constructor(newId: () => string) {
    this.newId = newId;
    this.id = newId();
  }

  current(): string {
    return this.id;
  }

  consume(candidate: string): boolean {
    if (candidate !== this.id) return false;
    this.id = this.newId();
    return true;
  }

  rotate(): void {
    this.id = this.newId();
  }
}
