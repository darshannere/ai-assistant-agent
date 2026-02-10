import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Extension } from "@codemirror/state"; 

/**
 * Creates a CodeMirror ViewPlugin that sends document updates over a WebSocket.
 * @param ws The WebSocket instance to send updates through.
 * @param userId The ID of the user making the changes.
 * @returns A CodeMirror Extension (ViewPlugin).
 */
export function createPersonalEditorUpdateExtension(ws: WebSocket, userId: string): Extension {
  return ViewPlugin.fromClass(class {
    constructor(private view: EditorView) {
    }

    update(update: ViewUpdate) {
      // `update.docChanged` is true if the document's content has changed.
      if (update.docChanged) {
        // Check if WebSocket is open and ready to send.
        if (ws && ws.readyState === WebSocket.OPEN) {
          const currentDoc = this.view.state.doc.toString();
          const payload = {
            userId: userId,
            doc: currentDoc, // The full content of the personal editor
            timeStamp: new Date().getTime()
          };

          ws.send(JSON.stringify({
            event: "updatePlayground", 
            payload: payload
          }));
          
        }
      }
    }

    // destroy() {
    //   // Perform any cleanup here if necessary (e.g., if the plugin had its own resources).
    // }
  });
}