// A tiny DOM builder. Text always goes in as text nodes, never as HTML (SPEC §9.2).

/** h("button", { class: "x", onclick: fn, disabled: true }, "text", child, [more children]) */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "class") element.className = value;
    else if (key === "value") element.value = value;
    else if (key === "checked") element.checked = value;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}

function append(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function replaceChildren(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

/** Runs `action` with `button` disabled; a thrown error goes to `onError`. */
export async function busy(button, action, onError) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    onError(error);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}
