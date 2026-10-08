/** A file that could not be read as what it is. Names the file so a failed night says which. */
export class ReadError extends Error {
  constructor(file, reason) {
    super(`${file}: ${reason}`);
    this.name = 'ReadError';
    this.file = file;
  }
}
