import type {
  CaptureState,
  ChatEntry,
  CheckableItem,
  NoteItem,
  SessionLifecycle,
  SessionState,
  SimulationState,
  TranscriptTurn,
} from "./types.js";

export type SessionAction =
  | { type: "topic.setChecked"; topicId: string; checked: boolean }
  | { type: "revisit.add"; item: CheckableItem }
  | { type: "revisit.setChecked"; itemId: string; checked: boolean }
  | { type: "question.add"; item: CheckableItem }
  | { type: "question.setChecked"; itemId: string; checked: boolean }
  | { type: "note.add"; note: NoteItem }
  | { type: "chat.add"; entry: ChatEntry }
  | { type: "transcript.append"; turn: TranscriptTurn }
  | { type: "elapsed.set"; elapsedMs: number }
  | { type: "capture.set"; capture: CaptureState }
  | { type: "lifecycle.set"; lifecycle: SessionLifecycle }
  | { type: "simulation.set"; simulation: SimulationState };

function setItemChecked(
  items: CheckableItem[],
  itemId: string,
  checked: boolean,
): CheckableItem[] {
  return items.map((item) =>
    item.id === itemId ? { ...item, checked } : item,
  );
}

export function reduceSession(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "topic.setChecked":
      return {
        ...state,
        topics: state.topics.map((topic) =>
          topic.id === action.topicId
            ? { ...topic, checked: action.checked }
            : topic,
        ),
      };
    case "revisit.add":
      return { ...state, revisit: [...state.revisit, action.item] };
    case "revisit.setChecked":
      return {
        ...state,
        revisit: setItemChecked(state.revisit, action.itemId, action.checked),
      };
    case "question.add":
      return { ...state, questions: [...state.questions, action.item] };
    case "question.setChecked":
      return {
        ...state,
        questions: setItemChecked(
          state.questions,
          action.itemId,
          action.checked,
        ),
      };
    case "note.add":
      return { ...state, notes: [...state.notes, action.note] };
    case "chat.add":
      return { ...state, chat: [...state.chat, action.entry] };
    case "transcript.append":
      return {
        ...state,
        transcript: [...state.transcript, action.turn].sort(compareTurns),
      };
    case "elapsed.set":
      return { ...state, elapsedMs: action.elapsedMs };
    case "capture.set":
      return { ...state, capture: action.capture };
    case "lifecycle.set":
      return { ...state, lifecycle: action.lifecycle };
    case "simulation.set":
      return { ...state, simulation: action.simulation };
  }
}

function compareTurns(left: TranscriptTurn, right: TranscriptTurn): number {
  return (
    left.startedAtMs - right.startedAtMs ||
    left.endedAtMs - right.endedAtMs ||
    left.id.localeCompare(right.id)
  );
}
