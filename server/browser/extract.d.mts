/** Types for the injected page reader (plain Node ESM). */

export interface ExtractionOptions {
  maxChars?: number;
  maxLinks?: number;
}

/** The expression evaluated inside the page; both protocols run the same one. */
export declare function extractionExpression(options?: ExtractionOptions): string;
