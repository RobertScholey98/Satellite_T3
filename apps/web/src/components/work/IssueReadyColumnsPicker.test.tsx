// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { IssueReadyColumnsPicker } from "./IssueReadyColumnsPicker";

const columns = [
  { id: "ready", title: "Ready" },
  { id: "refinement", title: "Ready for refinement" },
  { id: "progress", title: "In progress" },
];
let container: HTMLDivElement;
let root: Root;
const emptySelection: string[] = [];

function Harness({ initial = emptySelection }: { initial?: string[] }) {
  const [value, setValue] = useState(initial);
  return <IssueReadyColumnsPicker columns={columns} value={value} onChange={setValue} />;
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => element!.click());
}

function removeButton(title: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${title}"]`);
}

function option(title: string) {
  const element = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === title,
  );
  expect(element, `Missing ready column: ${title}`).toBeDefined();
  return element!;
}

async function open() {
  await click(container.querySelector('button[aria-label="Ready for development"]'));
}

async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search ready columns"]',
  );
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("IssueReadyColumnsPicker", () => {
  it("selects two ready columns, removes one, and allows it to be selected again", async () => {
    await act(async () => root.render(<Harness />));
    await open();
    await click(option("Ready"));
    await click(option("Ready for refinement"));

    expect(removeButton("Ready")).not.toBeNull();
    expect(removeButton("Ready for refinement")).not.toBeNull();
    expect(option("Ready").getAttribute("aria-selected")).toBe("true");
    expect(option("Ready for refinement").getAttribute("aria-selected")).toBe("true");

    await click(removeButton("Ready"));
    expect(removeButton("Ready")).toBeNull();
    expect(removeButton("Ready for refinement")).not.toBeNull();
    expect(option("Ready").getAttribute("aria-selected")).toBe("false");

    await click(option("Ready"));
    expect(removeButton("Ready")).not.toBeNull();
    expect(removeButton("Ready for refinement")).not.toBeNull();
  });

  it("filters columns by search without losing selections and permits an empty selection", async () => {
    await act(async () => root.render(<Harness initial={["ready"]} />));
    await open();
    await search("refinement");

    expect(
      [...document.querySelectorAll('[role="option"]')].map((item) => item.textContent?.trim()),
    ).toEqual(["Ready for refinement"]);
    expect(removeButton("Ready")).not.toBeNull();
    await click(option("Ready for refinement"));
    await search("no matching column");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);

    await search("");
    await click(removeButton("Ready"));
    await click(removeButton("Ready for refinement"));
    expect(container.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(0);
    expect(option("Ready").getAttribute("aria-selected")).toBe("false");
    expect(option("Ready for refinement").getAttribute("aria-selected")).toBe("false");
  });
});
