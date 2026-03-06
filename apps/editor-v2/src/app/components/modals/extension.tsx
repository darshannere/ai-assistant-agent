import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Extension } from "@codemirror/state"; 

/**
 * Creates a CodeMirror ViewPlugin that sends document updates and typing
 * indicators over a WebSocket whenever the personal editor content changes.
 */
export function createPersonalEditorUpdateExtension(ws: WebSocket, userId: string): Extension {
  let typingTimeout: ReturnType<typeof setTimeout> | null = null;

  return ViewPlugin.fromClass(class {
    constructor(private view: EditorView) {
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const currentDoc = this.view.state.doc.toString();

          ws.send(JSON.stringify({
            event: "updatePlayground", 
            payload: {
              userId: userId,
              doc: currentDoc,
              timeStamp: new Date().getTime()
            }
          }));

          ws.send(JSON.stringify({
            event: 'typing',
            payload: { id: userId, editor: 'personal' }
          }));

          if (typingTimeout) clearTimeout(typingTimeout);
          typingTimeout = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                event: 'stoppedTyping',
                payload: { id: userId }
              }));
            }
          }, 2000);
        }
      }
    }

    destroy() {
      if (typingTimeout) clearTimeout(typingTimeout);
    }
  });
}