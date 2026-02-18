import { basicSetup } from "codemirror"
import { EditorView } from "@codemirror/view"
import { python } from "@codemirror/lang-python"
import https from "https"
import {Tooltip, showTooltip} from "@codemirror/view"
import {StateField} from "@codemirror/state"
import {EditorState} from "@codemirror/state"
import { send } from "process"

interface UserState {
  state: string
  timestamp: number
}
const userStates: Record<string, UserState> = {};
const cursorTooltipBaseTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-cursor": {
    backgroundColor: "#66b",
    color: "white",
    border: "none",
    padding: "2px 7px",
    borderRadius: "4px",
    "& .cm-tooltip-arrow:before": {
      borderTopColor: "#66b"
    },
    "& .cm-tooltip-arrow:after": {
      borderTopColor: "transparent"
    }
  }
})

function checkUserInactivity() {
  const now = Date.now()/1000;
  const inactiveUsers:string[] = [];
  for (const [user, state] of Object.entries(userStates)) {
    if (now - state.timestamp > 60) {
      inactiveUsers.push(user);
    }

  }
  if( inactiveUsers.length > 0) {
    sendNotification(inactiveUsers,["5"]);
    for (const user of inactiveUsers) {
      delete userStates[user];
    }

  }
  return inactiveUsers;


}

async function sendNotification(users: string[], options: string[]) {
  const url=`https://${backendServer}:8000/notify`;
  const payload = {
    users: users,
    options: options
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      agent:new https.Agent({rejectUnauthorized:false})
    });

    if (response.ok) {
      return await response.json();
    } else {
      return {
        error: `Request failed with status code ${response.status}`,
        details: await response.text(),
      };
    }
  } catch (error) {
    return { error: String(error) };

  }
}

setInterval(checkUserInactivity, 20000);

async function selectTeammate(
  mapData: Record<string, string>,
  userWhoRequestedHelp: string
) {
  const blaringCode = mapData[userWhoRequestedHelp] || "";
  let prompt = `You are a teacher and User ${userWhoRequestedHelp} is stuck on the following code: ${blaringCode}. Please select a teammate to help. Check whoever is closer to their individual solution. Give response in JSON format of {type of mistake, who can help} JSON format only.\n`;

  for (const [user, state] of Object.entries(mapData)) {
    prompt += `\nUser ${user} current code is: ${state}\n`;

    try {
      if (state.includes("def")) {
        const functionName = state.match(/def (\w+)\(/)?.[1];
        if (functionName) {
          prompt += `Solution for ${functionName} is: Placeholder docstring\n`;
        }
      }
    } catch (error) {
      prompt += `Error parsing code: ${error}\n`;
    }
  }

  const response = await curlOllama(prompt);
  console.log(response.response);
  return response;
}


async function curlOllama( string = "Hi"): Promise<any> {
  const apiUrl = "http://prime-lab.cs.vt.edu:11434/api/generate";
  const payload = {
    model: "gemma3:27b",
    prompt: prompt,
    stream: false,
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return await response.json();
    } else {
      return {
        error: `Request failed with status code ${response.status}`,
        details: await response.text(),
      };
    }
  } catch (error) {
    return { error: String(error) };
  }
}

function getCursorTooltips(state: EditorState): readonly Tooltip[] {
  return state.selection.ranges
    .filter(range => range.empty)
    .map(range => {
      let line = state.doc.lineAt(range.head)
      let text = line.number + ":" + (range.head - line.from)
      return {
        pos: range.head,
        above: true,
        strictSide: true,
        arrow: true,
        create: () => {
          let dom = document.createElement("div")
          dom.className = "cm-tooltip-cursor"
          dom.textContent = text
          return {dom}
        }
      }
    })
}

const cursorTooltipField = StateField.define<readonly Tooltip[]>({
  create: getCursorTooltips,

  update(tooltips, tr) {
    if (!tr.docChanged && !tr.selection) return tooltips
    return getCursorTooltips(tr.state)
  },

  provide: f => showTooltip.computeN([f], state => state.field(f))
})

const backendServer = "localhost"
// const backendServer = "prime-lab.cs.vt.edu"

// const ws = new WebSocket("wss://prime-lab.cs.vt.edu:8000/ws/control");
const ws = new WebSocket(`ws://${backendServer}:8000/ws/control`);

let view: EditorView | null = null;
let lastDoc = ""

ws.addEventListener("message", (event) => {
  const data = JSON.parse(event.data)
  if (data["event"] === "initial" || data["event"] === "document_update") {
    console.log(data)
    const newDoc = data["payload"]["doc"]
    if (lastDoc !== newDoc) {
      lastDoc = newDoc
      view?.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: newDoc }
      });
    }
  }

  if (data["event"] === "monitorPlayground") {
    const map = data["payload"]["editors"]
    const individualsDiv = document.getElementById("individuals");
    for(const [user, state] of Object.entries(map)) {
      userStates[user] = {state: state, timestamp: Date.now()/1000};
    }
    checkUserInactivity();
    if (individualsDiv) {
      individualsDiv.innerHTML = "";
      for (let key of Object.keys(map)) {
        const value = map[key];

        // Create a new div element
        const entryDiv = document.createElement("div");
        entryDiv.style.display = "block";
        const editor = document.createElement("p");
        entryDiv.textContent = `${key}`;
        editor.textContent = `${value}`;
        editor.style.whiteSpace = "pre-line"
        entryDiv.appendChild(editor)

        // Append to the "individuals" div
        individualsDiv.appendChild(entryDiv);
      }

    }
  }
})


view = new EditorView({
  doc: "",
  extensions: [basicSetup, python(), EditorView.editable.of(false)],
  // extensions: [basicSetup, python()],
  parent: document.querySelector<HTMLDivElement>("#view")!
})


document.getElementById("fetch")?.addEventListener("click", getState)

async function getState() {
  const data = await fetch(`https://${backendServer}:8000/fetch`)
  const thing = await data.json()
  view?.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: thing["state"] }
  });

  const map = thing["individual"]
  const individualsDiv = document.getElementById("individuals");

  if (individualsDiv) {
    individualsDiv.innerHTML = "";
    for (let key of Object.keys(map)) {
      const value = map[key];

      // Create a new div element
      const entryDiv = document.createElement("div");
      const editor = document.createElement("p");
      entryDiv.textContent = `${key}`;
      editor.textContent = `${value}`;
      editor.style.whiteSpace = "pre-line"
      entryDiv.appendChild(editor)

      // Append to the "individuals" div
      individualsDiv.appendChild(entryDiv);
    }
  }

  const participants = document.getElementById("participants")

  const users = thing["users"]

  if (participants) {
    participants.innerHTML = ""
    for (let key of users) {
      const label = document.createElement("label");
      label.textContent = key;
      const user = document.createElement("input");
      user.type = "checkbox";
      user.id = key;
      user.name = "selected_users[]";
      label.prepend(user);
      participants.append(label)
    }
  }
}

document.getElementById("notificationForm")!.addEventListener("submit", function(event) {
  event.preventDefault();

  // Convert checkboxes into an array
  const selectedUsers: any[] = [];
  document.querySelectorAll('input[name="selected_users[]"]:checked').forEach((checkbox) => {
    selectedUsers.push(checkbox.id);
  });

  const options: any[] = [];
  document.querySelectorAll('input[name="option[]"]:checked').forEach((checkbox: any) => {
    options.push(checkbox.value);
  });

  const data = {
    users: selectedUsers,
    options: options
  };

  fetch(`https://${backendServer}:8000/notify`, {
    method: "POST",
  body: JSON.stringify(data),
  headers: { "Content-Type": "application/json" }
  })
  .then(response => response.json())
  .then(() => {
    console.log("success")
  })
  .catch(err => {
    console.log(err)
  })
});
