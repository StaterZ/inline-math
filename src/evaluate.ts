import LRU from 'lru-cache';
import * as math from 'mathjs';
import { Range, Selection, Position, TextEditor } from 'vscode';
import { Evaluation } from './types';

type Zip<T extends unknown[][]> = {
  [I in keyof T]: T[I] extends (infer U)[] ? U : never;
};
const zip = <T extends unknown[][]>(...arrays: T): Zip<T>[] => {
  const length = Math.min(...arrays.map(a => a.length));
  return Array.from({ length }, (_, i) => arrays.map(a => a[i]) as Zip<T>);
};

type EvaluationResult = {
  source: string;
  result: string;
  desirable: boolean;
};

/**
 * Cache will contain:
 *  - [Entire line's text as string, { source: subselection, result } ]
 */
const resultCache = new LRU<readonly string[], readonly Evaluation[]>({
  max: 300,
});

export function getEvaluations(editor: TextEditor): readonly Evaluation[] {
  const parser = math.parser();
  const selections = splitSelectionsToLines(editor, editor.selections)
    .map(selection => selection.isEmpty ? editor.document.lineAt(selection.end.line).range : selection);
  selections.sort((lhs, rhs) => lhs.start.line - rhs.start.line); //ensures that if we select things in reverse order, things still evaluate in line order

  const selectionsText = selections.map(range => editor.document.getText(range).trim());
  if (resultCache.has(selectionsText)) {
    return resultCache.get(selectionsText)!;
  }

  const evaluations: Evaluation[] = [];
  for (const [range, text] of zip(selections, selectionsText)) {
    const { result, source, desirable } = getEvaluation(text, parser);
    if (!desirable) { continue; };

    evaluations.push({
      result,
      source,
      range,
    });
  }

  resultCache.set(selectionsText, evaluations);
  return evaluations;
}

function splitSelectionsToLines(editor: TextEditor, selections: readonly Selection[]): Selection[] {
  const result: Selection[] = [];

  for (const selection of selections) {
    if (selection.start.line === selection.end.line) {
      // Single-line: keep as-is
      result.push(selection);
    } else {
      // First line: from original start to end of start line
      result.push(
        new Selection(
          selection.start,
          editor.document.lineAt(selection.start.line).range.end
        )
      );

      // Middle lines
      for (let line = selection.start.line + 1; line < selection.end.line; line++) {
        const range = editor.document.lineAt(line).range;
        result.push(new Selection(range.start, range.end));
      }

      // Last line: from column 0 to original end
      result.push(new Selection(new Position(selection.end.line, 0), selection.end));
    }
  }

  return result;
}

function getEvaluation(text: string, parser: math.Parser): EvaluationResult {
  for (const subSelection of generateSubselections(text)) {
    const source = subSelection.join(' ').trim();
    try {
      // If the string is not calculable, this will throw
      const raw = parser.evaluate(source);

      // So here, we have a result
      const result = raw.toString();

      // Include `desirable` prop here so it is also cached - otherwise could simply add a check to parent function
      return { result, source, desirable: isDesirableResult(source, result) };
    } catch (_) {
      // Error during evaluation - expected.
      // In this case, do not return - try the next subSelection
    }
  }

  return {} as EvaluationResult;
}

function isDesirableResult(source: string, result: string | undefined): result is string {
  const trimmed = source.trim();
  return (
    result !== undefined &&
    result !== trimmed &&
    // handles 'source' === result && "source" === result
    result !== trimmed.substring(1, source.length - 1) &&
    !result.startsWith('function')
  );
}

// provides subsets in size order
function* generateSubselections(text: string) {
  const parts = text.split(' ');

  for (let size = parts.length; size > 0; size--) {
    for (let offset = 0; offset <= parts.length - size; offset++) {
      yield parts.slice(offset, size + offset);
    }
  }
}
