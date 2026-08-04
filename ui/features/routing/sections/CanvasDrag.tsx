'use client';

import type { ReactNode } from 'react';
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  TraversalOrder,
  closestCenter,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragMoveEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';

/**
 * Dragging one status onto another to propose a transition.
 *
 * dnd-kit rather than raw pointer events, despite this being a "draw a connection" gesture
 * rather than dnd-kit's usual "move an element". The deciding factor is hit testing: every arc
 * on the canvas is painted twice, the second copy being an invisible 12px-wide stroke that
 * exists purely as a click target, and the outcome labels sit above the node layer. Anything
 * built on elementFromPoint would land on those instead of the node underneath.
 *
 * dnd-kit also brings click/drag disambiguation and nested auto-scroll for free, both of which
 * are load-bearing here and neither of which is trivial to redo.
 */

/** Non-default DndContext settings. Each one is here because its default is wrong for this canvas. */
const MEASURING = {
  droppable: {
    strategy: MeasuringStrategy.Always,
    // The NUMERIC frequency is the load-bearing part. dnd-kit's default is 'optimized', and its
    // periodic re-measure early-returns unless frequency is a number — so droppable rects go
    // stale the moment the canvas or page scrolls mid-drag and every hit test is off by the
    // scrolled distance. MeasuringStrategy.Always alone does not fix it.
    frequency: 100,
  },
};

const AUTO_SCROLL = {
  // Auto-scroll walks scrollable ancestors outermost-first and stops at the first one with a
  // non-zero speed. On this page the outer container is the page scroller and the inner one is
  // the canvas card, so the default order means dragging toward the right edge of a wide graph
  // scrolls the page vertically and never scrolls the canvas horizontally.
  order: TraversalOrder.ReversedTreeOrder,
};

export interface ConnectDragData {
  type: 'connect';
  from: string;
}

export interface StatusDropData {
  type: 'status';
  status: string;
}

export function CanvasDndProvider({
  children,
  onConnect,
  onDragMove,
  onDragStart,
  onDragCancel,
}: {
  children: ReactNode;
  /** Fired when a connection drag is released on a status node. */
  onConnect: (from: string, to: string) => void;
  onDragMove: (delta: { x: number; y: number } | null) => void;
  onDragStart: (from: string) => void;
  onDragCancel: () => void;
}) {
  // distance: 8 makes a click still a click. dnd-kit also swallows the click that follows a
  // real drag, so node selection needs no isDragging guard of its own.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleEnd = (event: DragEndEvent) => {
    onDragMove(null);
    const active = event.active.data.current as ConnectDragData | undefined;
    const over = event.over?.data.current as StatusDropData | undefined;
    // Read the target from data, never by parsing the droppable id.
    if (active?.type === 'connect' && over?.type === 'status') {
      onConnect(active.from, over.status);
      return;
    }
    onDragCancel();
  };

  return (
    <DndContext
      sensors={sensors}
      // closestCenter, not pointerWithin: statuses are spaced 78px apart but only 58px tall, so
      // there is a 20px dead band between every pair plus the full width of both gutters.
      // pointerWithin returns no target there and the gesture silently does nothing.
      collisionDetection={closestCenter}
      measuring={MEASURING}
      autoScroll={AUTO_SCROLL}
      onDragStart={(event) => {
        const data = event.active.data.current as ConnectDragData | undefined;
        if (data?.type === 'connect') onDragStart(data.from);
      }}
      onDragMove={(event: DragMoveEvent) => onDragMove(event.delta)}
      onDragEnd={handleEnd}
      onDragCancel={() => { onDragMove(null); onDragCancel(); }}
    >
      {children}
    </DndContext>
  );
}

/**
 * The grab target for starting a connection.
 *
 * Deliberately a separate element rather than listeners on the node button. PointerSensor
 * activates on a bubbling pointerdown, and the workflow-event chips inside a node stop
 * propagation only on click and keydown — so spreading listeners on the button would turn
 * those chips into drag handles and, because dnd-kit suppresses the click that follows a drag,
 * silently break their own selection.
 */
export function ConnectHandle({ statusId, x, y }: { statusId: string; x: number; y: number }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `connect-${statusId}`,
    data: { type: 'connect', from: statusId } satisfies ConnectDragData,
  });

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      // touch-none, or the browser claims the gesture as a pan on a horizontally
      // scrollable canvas and the drag never starts.
      className={`absolute z-20 flex h-4 w-4 touch-none cursor-crosshair items-center justify-center rounded-full border transition-colors ${
        isDragging
          ? 'border-amber-400 bg-amber-400'
          : 'border-slate-600 bg-slate-800 hover:border-amber-400 hover:bg-amber-500/30'
      }`}
      style={{ left: x - 8, top: y - 8 }}
      title={`Drag from ${statusId} to another status to add a transition`}
      aria-label={`Add a transition from ${statusId}`}
    >
      <span className="h-1 w-1 rounded-full bg-slate-400" />
    </button>
  );
}

/** Wraps a status node so it can receive a connection drag. */
export function StatusDropTarget({
  statusId,
  children,
}: {
  statusId: string;
  children: (isOver: boolean, setRef: (element: HTMLElement | null) => void) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `status-${statusId}`,
    data: { type: 'status', status: statusId } satisfies StatusDropData,
  });
  return <>{children(isOver, setNodeRef)}</>;
}
