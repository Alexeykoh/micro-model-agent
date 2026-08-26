export interface TrackedDecision {
  decision: string;
  location: string;
}

export class ConsistencyCheck {
  private decisions: TrackedDecision[] = [];
  private createdFiles: Set<string> = new Set();
  private deletedFiles: Set<string> = new Set();

  trackDecision(decision: string, location: string): void {
    this.decisions.push({ decision, location });
  }

  trackCreatedFile(path: string): void {
    this.createdFiles.add(path);
    // A delete followed by a re-create un-deletes the file — otherwise
    // wasFileDeleted() keeps reporting it as gone after delete+create.
    this.deletedFiles.delete(path);
  }

  trackDeletedFile(path: string): void {
    this.deletedFiles.add(path);
  }

  getCreatedFiles(): string[] {
    return Array.from(this.createdFiles);
  }

  getDeletedFiles(): string[] {
    return Array.from(this.deletedFiles);
  }

  getDecisions(): TrackedDecision[] {
    return this.decisions;
  }

  hasDecisions(): boolean {
    return this.decisions.length > 0;
  }
}
