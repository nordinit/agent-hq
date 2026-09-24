'use client';
import { type CSSProperties, useEffect, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Settings2, Copy, Trash2, Plus, ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';
import type { DashboardBlock, DashboardColumn, DashboardDocument, DashboardSection } from '@/lib/dashboardTypes';
import { dashboardId, findDashboardBlock, moveDashboardBlock, removeDashboardBlock, resizeDashboardColumns, setDashboardColumns } from '@/lib/dashboardLayout';
import type { TelemetryCatalog } from '@/lib/telemetryTypes';
import type { DashboardMetricState, DashboardOperations } from './useDashboardData';
import { DashboardBlockContent, type DashboardInspection } from './DashboardBlocks';
import styles from './dashboard.module.css';

interface Props {
  page: DashboardDocument; editing: boolean; selected: string | null; data: Record<string, DashboardMetricState>; operations: DashboardOperations; catalog: TelemetryCatalog | null;
  change: (page: DashboardDocument) => void; select: (id: string) => void; insert: (columnId: string) => void; inspect: (value: DashboardInspection) => void;
}
function SortableBlock({ block, column, ...props }: Props & { block: DashboardBlock; column: DashboardColumn }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: !props.editing, data: { columnId: column.id } });
  const index = column.blocks.findIndex(item => item.id === block.id);
  const title = block.title || (block.type === 'operation' ? block.operation : block.type);
  const move = (delta: number) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= column.blocks.length) return;
    props.change(moveDashboardBlock(props.page, block.id, column.id, delta < 0 ? column.blocks[nextIndex].id : column.blocks[nextIndex + 1]?.id));
  };
  return <article ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? .45 : 1, zIndex: isDragging ? 10 : undefined }} className={`${styles.block} ${props.editing && props.selected === block.id ? styles.selected : ''}`}>
    {props.editing && <div className={styles.blockControls}>
      <button type="button" className={`${styles.button} ${styles.dragHandle}`} {...attributes} {...listeners} aria-label={`Move ${title}`}><GripVertical/></button>
      <div className={styles.actions}><button className={styles.button} type="button" onClick={() => props.select(block.id)} aria-label={`Settings for ${title}`}><Settings2/></button><button className={styles.button} type="button" disabled={index === 0} onClick={() => move(-1)} aria-label={`Move ${title} earlier`}><ArrowUp/></button><button className={styles.button} type="button" disabled={index === column.blocks.length - 1} onClick={() => move(1)} aria-label={`Move ${title} later`}><ArrowDown/></button>
      <button className={styles.button} type="button" aria-label={`Duplicate ${title}`} onClick={() => {
        const next = structuredClone(props.page), copy = { ...structuredClone(block), id: dashboardId() };
        next.sections.flatMap(section => section.columns).find(item => item.id === column.id)!.blocks.splice(index + 1, 0, copy); props.change(next); props.select(copy.id);
      }}><Copy/></button><button type="button" className={styles.button} aria-label={`Remove ${title}`} onClick={() => props.change(removeDashboardBlock(props.page, block.id))}><Trash2/></button></div>
    </div>}
    <div className={styles.blockContent}><DashboardBlockContent {...props} block={block}/></div>
  </article>;
}
function Column({ column, ...props }: Props & { column: DashboardColumn }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: !props.editing, data: { columnId: column.id } });
  return <div ref={setNodeRef} style={{ '--column-width': column.width } as CSSProperties} className={`${styles.column} ${isOver ? styles.dropOver : ''}`}>
    <SortableContext items={column.blocks.map(block => block.id)} strategy={verticalListSortingStrategy}>{column.blocks.map(block => <SortableBlock key={block.id} column={column} block={block} {...props}/>)}</SortableContext>
    {props.editing && <button type="button" className={styles.addBlock} onClick={() => props.insert(column.id)}>+ Add block</button>}
  </div>;
}
function Section({ section, index, ...props }: Props & { section: DashboardSection; index: number }) {
  const [collapsed, setCollapsed] = useState(section.collapsed ?? false);
  useEffect(() => setCollapsed(section.collapsed ?? false), [section.collapsed]);
  const toggle = () => { setCollapsed(!collapsed); if (props.editing) props.change({ ...props.page, sections: props.page.sections.map(item => item.id === section.id ? { ...item, collapsed: !collapsed } : item) }); };
  const moveSection = (delta: number) => { const sections = [...props.page.sections]; const [moved] = sections.splice(index, 1); sections.splice(index + delta, 0, moved); props.change({ ...props.page, sections }); };
  return <section className={styles.section}>
    {(section.title || props.editing) && <div className={styles.sectionHeader}><div className={styles.sectionTitle}><button type="button" className={`${styles.button} ${styles.iconButton}`} onClick={toggle} aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${section.title || 'section'}`}>{collapsed ? <ChevronRight/> : <ChevronDown/>}</button>{props.editing ? <input className={styles.input} aria-label="Section title" value={section.title} placeholder="Section title" onChange={event => props.change({ ...props.page, sections: props.page.sections.map(item => item.id === section.id ? { ...item, title: event.target.value } : item) })}/> : <h2>{section.title}</h2>}</div>
      {props.editing && <div className={styles.actions}><select className={styles.input} aria-label={`Columns in ${section.title || 'section'}`} value={section.columns.length} onChange={event => props.change(setDashboardColumns(props.page, section.id, Number(event.target.value)))}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} {count === 1 ? 'column' : 'columns'}</option>)}</select>
        <button className={styles.button} type="button" disabled={index === 0} onClick={() => moveSection(-1)} aria-label="Move section up"><ArrowUp/></button><button className={styles.button} type="button" disabled={index === props.page.sections.length - 1} onClick={() => moveSection(1)} aria-label="Move section down"><ArrowDown/></button>
        <button className={styles.button} type="button" aria-label={`Remove section ${section.title}`} onClick={() => {
          let next = props.page;
          for (const block of section.columns.flatMap(column => column.blocks)) next = removeDashboardBlock(next, block.id);
          props.change({ ...next, sections: next.sections.filter(item => item.id !== section.id) });
        }}><Trash2/></button>
      </div>}
    </div>}
    {(!collapsed || props.editing) && <><div className={styles.columns}>{section.columns.map(column => <Column key={column.id} column={column} {...props}/>)}</div>{props.editing && section.columns.length > 1 && <div className={styles.resize}>{section.columns.slice(0, -1).map((column, i) => <label key={column.id} className={styles.actions}>Columns {i + 1}/{i + 2}<input type="range" aria-label={`Resize columns ${i + 1} and ${i + 2} in ${section.title || 'section'}`} min={1} max={column.width + section.columns[i + 1].width - 1} value={column.width} onChange={event => props.change(resizeDashboardColumns(props.page, section.id, i, Number(event.target.value)))}/>{column.width}:{section.columns[i + 1].width}</label>)}</div>}</>}
  </section>;
}
export default function DashboardCanvas(props: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
    if (!over || active.id === over.id || !findDashboardBlock(props.page, String(active.id))) return;
    const columnId = over.data.current?.columnId as string | undefined;
    if (!columnId) return;
    const column = props.page.sections.flatMap(section => section.columns).find(item => item.id === columnId)!;
    const from = column.blocks.findIndex(block => block.id === active.id), to = column.blocks.findIndex(block => block.id === over.id);
    // Sorting downward must insert after the hovered block; inserting before it
    // makes dragging the first of two blocks onto the second a no-op.
    const beforeId = from >= 0 && to > from ? column.blocks[to + 1]?.id : to >= 0 ? String(over.id) : undefined;
    props.change(moveDashboardBlock(props.page, String(active.id), columnId, beforeId));
  }}><div className={`${styles.canvas} ${props.editing ? styles.editing : ''}`}>
    {!props.page.sections.length && <p className={styles.empty}>Add a section to start composing your dashboard.</p>}
    {props.page.sections.map((section, index) => <Section key={section.id} section={section} index={index} {...props}/>)}
    {props.editing && <button type="button" className={styles.addBlock} onClick={() => props.change({ ...props.page, sections: [...props.page.sections, { id: dashboardId(), title: 'New section', columns: [{ id: dashboardId(), width: 12, blocks: [] }] }] })}><Plus className="inline h-4 w-4"/> Add section</button>}
  </div></DndContext>;
}
