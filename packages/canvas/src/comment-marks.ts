/**
 * @fileoverview Comment count marks, drawn in their own layer above every object.
 *
 * Each object on the board is its own stacking context (`z-index` from its outline order plus a
 * `transform`), so a mark appended inside its object was painted under any later sibling and under
 * the object's own children, and a neighbouring image cut it off. The marks live in `#commentMarks`,
 * the last child of `#board`, placed in board pixels at the top-right of the object's drawn box.
 * They follow the object through a MutationObserver on the layer (a drag writes `style` directly,
 * the camera writes the layer's `transform`), batched to one placement per animation frame.
 */

/** The box a mark sits beside: a group has no size of its own, so its hit bounds stand in. */
function drawnBox(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>(':scope > .group-bounds') ?? el;
}

const GAP = 14;

export class CommentMarks {
  private marks = new Map<string, HTMLElement>();
  private elements = new Map<string, HTMLElement>();
  private frame = 0;
  private layer: HTMLElement;

  constructor(
    private board: HTMLElement,
    private makeIcon: () => Element
  ) {
    let layer = board.querySelector<HTMLElement>(':scope > #commentMarks');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'commentMarks';
      board.append(layer);
    }
    this.layer = layer;
    const objects = board.querySelector('#layer');
    if (objects)
      new MutationObserver(() => this.schedule()).observe(objects, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'data-view', 'hidden'],
      });
    addEventListener('resize', () => this.schedule());
  }

  /** Show `counts` beside the matching elements; an object with no comments has no mark. */
  update(counts: Map<string, number>, elements: Map<string, HTMLElement>): void {
    this.elements = elements;
    for (const [id, mark] of this.marks)
      if (!counts.get(id) || !elements.has(id)) {
        mark.remove();
        this.marks.delete(id);
      }
    for (const [id, count] of counts) {
      if (!count || !elements.has(id)) continue;
      let mark = this.marks.get(id);
      if (!mark) {
        mark = document.createElement('button');
        (mark as HTMLButtonElement).type = 'button';
        mark.className = 'comment-mark';
        // Objects on the board are not tab stops either; the thread is reached from a selection by keyboard.
        mark.tabIndex = -1;
        mark.dataset.markFor = id;
        mark.append(this.makeIcon(), document.createElement('span'));
        this.layer.append(mark);
        this.marks.set(id, mark);
      }
      const text = mark.lastElementChild;
      if (text && text.textContent !== String(count)) {
        text.textContent = String(count);
        const name = `${count} ${count === 1 ? 'comment' : 'comments'}`;
        mark.setAttribute('aria-label', `${name}. Open the thread`);
        mark.title = name;
      }
    }
    this.place();
  }

  private schedule(): void {
    if (this.frame || !this.marks.size) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  }

  private place(): void {
    if (!this.marks.size) return;
    const origin = this.board.getBoundingClientRect();
    for (const [id, mark] of this.marks) {
      const el = this.elements.get(id);
      const shown = !!el && el.isConnected && getComputedStyle(el).visibility !== 'hidden';
      mark.hidden = !shown;
      if (!shown || !el) continue;
      const box = drawnBox(el).getBoundingClientRect();
      mark.style.left = `${box.right - origin.left + GAP}px`;
      mark.style.top = `${box.top - origin.top}px`;
    }
  }
}
