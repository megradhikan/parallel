import { useEffect } from "react";
import type * as monacoNs from "monaco-editor";
import * as Y from "yjs";
import { monaco } from "../lib/monacoSetup";

export interface UseMonacoBindingArgs {
  editor: monacoNs.editor.IStandaloneCodeEditor | null;
  ydoc: Y.Doc;
  ytext: Y.Text;
}

// Each binding instance tags its own transactions with a unique object so it
// can recognise (and skip) the edits it already wrote into its model. A shared
// string constant would make two bindings on one Y.Doc ignore each other —
// exactly the case the isolation harness in binding-test.html exercises.
const makeLocalOrigin = () => ({ monacoBinding: true });

// The hand-rolled Monaco <-> Yjs binding (PRD 6.4). This is what `y-monaco`
// would otherwise do; writing it by hand is the point of the project.
//
// Two directions, one shared guard:
//
//   Monaco -> Yjs   model.onDidChangeContent gives {rangeOffset, rangeLength,
//                   text} per change; each becomes a delete and/or insert on
//                   the Y.Text inside one transaction tagged LOCAL_ORIGIN.
//
//   Yjs -> Monaco   ytext.observe gives a delta (retain/insert/delete) for any
//                   update that did not come from this editor — a remote user,
//                   or the server's AI stream. Each op is translated into a
//                   model.applyEdits() call, never model.setValue(): setValue
//                   resets the cursor and destroys the undo stack, which on a
//                   remote keystroke means the local user loses their place
//                   several times a second.
//
// `isApplyingRemote` breaks the loop between the two: without it, every remote
// edit written into the model fires onDidChangeContent, gets re-applied to the
// Y.Text, re-broadcast, and the two clients ping-pong forever.
export function useMonacoBinding({ editor, ydoc, ytext }: UseMonacoBindingArgs): void {
  useEffect(() => {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    const localOrigin = makeLocalOrigin();
    let isApplyingRemote = false;

    const applyRemote = (fn: () => void) => {
      isApplyingRemote = true;
      try {
        fn();
      } finally {
        isApplyingRemote = false;
      }
    };

    // Seed the model from whatever the Y.Text already holds. setValue is only
    // acceptable here: there is no cursor to move and no undo history to lose
    // before the user has touched the editor.
    if (model.getValue() !== ytext.toString()) {
      applyRemote(() => model.setValue(ytext.toString()));
    }

    const changeSub = model.onDidChangeContent((event) => {
      if (isApplyingRemote) return; // echo of a remote edit — do not re-broadcast

      ydoc.transact(() => {
        // Monaco orders `changes` from the end of the document backwards, so a
        // multi-cursor edit (one event, several non-contiguous ranges) can be
        // applied in the given order without any offset bookkeeping.
        for (const change of event.changes) {
          if (change.rangeLength > 0) ytext.delete(change.rangeOffset, change.rangeLength);
          if (change.text.length > 0) ytext.insert(change.rangeOffset, change.text);
        }
      }, localOrigin);
    });

    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === localOrigin) return; // already in the model

      applyRemote(() => {
        // Walk the delta against the model, applying each op as we go so that
        // getPositionAt() reflects the ops already applied. `index` tracks the
        // position in the post-edit document, which is why inserts advance it
        // and deletes do not.
        let index = 0;
        for (const op of event.delta) {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (typeof op.insert === "string") {
            const pos = model.getPositionAt(index);
            model.applyEdits([
              {
                range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
                text: op.insert,
                forceMoveMarkers: true,
              },
            ]);
            index += op.insert.length;
          } else if (op.delete !== undefined) {
            const start = model.getPositionAt(index);
            const end = model.getPositionAt(index + op.delete);
            model.applyEdits([
              {
                range: new monaco.Range(
                  start.lineNumber,
                  start.column,
                  end.lineNumber,
                  end.column
                ),
                text: null,
              },
            ]);
          }
        }
      });
    };

    ytext.observe(observer);

    return () => {
      changeSub.dispose();
      ytext.unobserve(observer);
    };
  }, [editor, ydoc, ytext]);
}
