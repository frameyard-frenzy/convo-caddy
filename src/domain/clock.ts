export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  #currentMs: number;

  constructor(initialTime: string | number | Date) {
    this.#currentMs = new Date(initialTime).getTime();
  }

  now(): Date {
    return new Date(this.#currentMs);
  }

  advance(milliseconds: number): void {
    this.#currentMs += milliseconds;
  }
}
