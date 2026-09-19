import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposedGraph, TopicNode } from '../lib/types';
import { GraphCanvas } from './GraphCanvas';

const intent: TopicNode = {
  id: 'intent:graph',
  kind: 'custom',
  title: 'Dynamic graph',
  objective: 'Propose a dynamic execution graph.',
  context: '',
  status: 'draft',
  position: { x: 80, y: 80 },
};

const proposedGraph: ProposedGraph = {
  proposalId: 'proposal:dynamic',
  schemaVersion: 'intent-proposed-graph/v2',
  status: 'PROPOSED',
  compilerVersion: 'configured-ai-proposal/2.0.0',
  contentDigest: `sha256:${'d'.repeat(64)}`,
  selectedDomains: ['graph-reasoning', 'interaction-verification'],
  nodes: [
    {
      id: 'specialist:reasoning',
      type: 'SPECIALIST_AGENT',
      domain: 'graph-reasoning',
      title: 'Graph reasoning',
      objective: 'Decompose the supplied intent.',
      agentId: 'graph-agent',
      promptDigest: `sha256:${'1'.repeat(64)}`,
      dependsOn: [],
      acceptanceCriteria: ['The decomposition remains traceable.'],
      inputs: [{ id: 'intent', type: 'intent', required: true }],
      outputs: [{ id: 'graph', type: 'graph', required: true }],
      traceability: { intentNodeIds: [intent.id], evidenceIds: [] },
    },
    {
      id: 'specialist:interaction-check',
      type: 'SPECIALIST_AGENT',
      domain: 'interaction-verification',
      title: 'Interaction verification',
      objective: 'Verify graph interaction and movement.',
      agentId: 'qa-agent',
      promptDigest: `sha256:${'2'.repeat(64)}`,
      dependsOn: ['specialist:reasoning'],
      acceptanceCriteria: ['Proposal selection remains stable.'],
      inputs: [{ id: 'graph', type: 'graph', required: true }],
      outputs: [{ id: 'receipt', type: 'verification', required: true }],
      traceability: { intentNodeIds: [intent.id], evidenceIds: [] },
    },
  ],
  relationships: [{
    id: 'relationship:requires',
    type: 'REQUIRES',
    source: 'specialist:reasoning',
    target: 'specialist:interaction-check',
    rationale: 'Verification follows graph definition.',
    traceability: { intentNodeIds: [intent.id], evidenceIds: [] },
  }],
};

describe('GraphCanvas real React Flow integration', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('selects a proposal repeatedly without a selection feedback crash', () => {
    const onSelectNode = vi.fn();
    const onSelectProposalNode = vi.fn();
    const view = render(
      <div style={{ width: 1_000, height: 700 }}>
        <GraphCanvas
          nodes={[intent]}
          edges={[]}
          proposedGraph={proposedGraph}
          onSelectNode={onSelectNode}
          onSelectProposalNode={onSelectProposalNode}
          onPositionChange={vi.fn()}
        />
      </div>,
    );

    const proposalNode = screen.getByTestId('rf__node-proposal::specialist:reasoning');
    expect(proposalNode).toHaveAttribute('aria-label', 'Select proposed specialist Graph reasoning');
    fireEvent.click(proposalNode);
    expect(onSelectProposalNode).toHaveBeenLastCalledWith('specialist:reasoning');

    view.rerender(
      <div style={{ width: 1_000, height: 700 }}>
        <GraphCanvas
          nodes={[intent]}
          edges={[]}
          proposedGraph={proposedGraph}
          selectedProposalNodeId="specialist:reasoning"
          onSelectNode={onSelectNode}
          onSelectProposalNode={onSelectProposalNode}
          onPositionChange={vi.fn()}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId('rf__node-proposal::specialist:reasoning'));
    expect(onSelectProposalNode).toHaveBeenCalledTimes(2);
  });

  it('selects an intent node without clearing it through the pane', () => {
    const onSelectNode = vi.fn();
    const onSelectProposalNode = vi.fn();
    render(
      <div style={{ width: 1_000, height: 700 }}>
        <GraphCanvas
          nodes={[intent]}
          edges={[]}
          onSelectNode={onSelectNode}
          onSelectProposalNode={onSelectProposalNode}
          onPositionChange={vi.fn()}
        />
      </div>,
    );

    fireEvent.click(screen.getByTestId(`rf__node-${intent.id}`));

    expect(onSelectProposalNode).toHaveBeenLastCalledWith(undefined);
    expect(onSelectNode).toHaveBeenLastCalledWith(intent.id);
    expect(onSelectNode).not.toHaveBeenCalledWith(undefined);
  });

  it.each([
    ['Shift', 'shiftKey'], ['Meta', 'metaKey'], ['Control', 'ctrlKey'],
  ] as const)('preserves the current group through pointer start and adds a node with %s-click', (key, modifier) => {
    const second = { ...intent, id: 'intent:evidence', title: 'Evidence', position: { x: 400, y: 80 } };
    function ControlledSelection() {
      const [selected, setSelected] = useState([intent.id]);
      return <div style={{ width: 1_000, height: 700 }}>
        <output aria-label="Selected intent nodes">{selected.join(',')}</output>
        <GraphCanvas
          nodes={[intent, second]}
          edges={[]}
          selectedNodeId={selected[0]}
          selectedNodeIds={selected}
          onSelectionChange={setSelected}
          onSelectNode={(id) => setSelected(id ? [id] : [])}
          onSelectProposalNode={vi.fn()}
          onPositionChange={vi.fn()}
        />
      </div>;
    }
    render(<ControlledSelection />);
    const node = screen.getByTestId(`rf__node-${second.id}`);
    fireEvent.keyDown(window, { key, [modifier]: true });
    const mouseEvent = (type: string, init: MouseEventInit) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init, [modifier]: true });
      Object.defineProperty(event, 'view', { value: window });
      return event;
    };
    fireEvent(node, mouseEvent('mousedown', { button: 0, buttons: 1, clientX: 420, clientY: 100 }));
    expect(screen.getByLabelText('Selected intent nodes')).toHaveTextContent(intent.id);
    fireEvent(window, mouseEvent('mouseup', { button: 0, buttons: 0, clientX: 420, clientY: 100 }));
    fireEvent(node, mouseEvent('click', { button: 0, buttons: 0, clientX: 420, clientY: 100 }));
    expect(screen.getByLabelText('Selected intent nodes')).toHaveTextContent(`${intent.id},${second.id}`);
    expect(screen.getByTestId(`rf__node-${intent.id}`)).toHaveClass('selected');
    expect(screen.getByTestId(`rf__node-${second.id}`)).toHaveClass('selected');
    fireEvent.keyUp(window, { key });
  });

  it('moves an intent node through the real React Flow mouse-drag path without moving the viewport away', async () => {
    const onPositionChange = vi.fn();
    const bounds = {
      x: 0, y: 0, left: 0, top: 0, right: 1_000, bottom: 700, width: 1_000, height: 700,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    render(
      <div style={{ width: 1_000, height: 700 }}>
        <GraphCanvas
          nodes={[intent]}
          edges={[]}
          onSelectNode={vi.fn()}
          onSelectProposalNode={vi.fn()}
          onPositionChange={onPositionChange}
        />
      </div>,
    );

    const flowNode = screen.getByTestId(`rf__node-${intent.id}`);
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    const viewportTransform = viewport?.style.transform;
    const mouseEvent = (type: string, init: MouseEventInit) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, 'view', { value: window });
      return event;
    };
    fireEvent(flowNode, mouseEvent('mousedown', { button: 0, buttons: 1, clientX: 100, clientY: 100 }));
    fireEvent(window, mouseEvent('mousemove', { buttons: 1, clientX: 340, clientY: 260 }));
    fireEvent(window, mouseEvent('mouseup', { button: 0, buttons: 0, clientX: 340, clientY: 260 }));

    await waitFor(() => expect(onPositionChange).toHaveBeenCalled());
    const [, movedPosition] = onPositionChange.mock.calls.at(-1) as [string, { x: number; y: number }];
    expect(movedPosition.x).toBeGreaterThan(intent.position.x);
    expect(movedPosition.y).toBeGreaterThan(intent.position.y);
    expect(screen.getByTestId(`rf__node-${intent.id}`)).toBeInTheDocument();
    expect(viewport?.style.transform).toBe(viewportTransform);
  });

  it('keeps real intent and proposal nodes measured, visible, and draggable after controlled rerenders', async () => {
    const onPositionChange = vi.fn();
    const bounds = {
      x: 0, y: 0, left: 0, top: 0, right: 1_000, bottom: 700, width: 1_000, height: 700,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    render(
      <div style={{ width: 1_000, height: 700 }}>
        <GraphCanvas
          nodes={[intent]}
          edges={[]}
          proposedGraph={proposedGraph}
          onSelectNode={vi.fn()}
          onSelectProposalNode={vi.fn()}
          onPositionChange={onPositionChange}
        />
      </div>,
    );

    const intentNode = screen.getByTestId(`rf__node-${intent.id}`);
    const proposalNode = screen.getByTestId('rf__node-proposal::specialist:reasoning');
    expect(intentNode).toHaveStyle({ visibility: 'visible' });
    expect(proposalNode).toHaveStyle({ visibility: 'visible' });

    dragNode(proposalNode, { x: 120, y: 120 }, { x: 330, y: 250 });
    await waitFor(() => expect(localStorage.getItem(`ege.proposal-layout.v1:${proposedGraph.contentDigest}`)).toContain('specialist:reasoning'));
    expect(screen.getByTestId('rf__node-proposal::specialist:reasoning')).toHaveStyle({ visibility: 'visible' });

    dragNode(screen.getByTestId(`rf__node-${intent.id}`), { x: 120, y: 120 }, { x: 300, y: 280 });
    await waitFor(() => expect(onPositionChange).toHaveBeenCalled());
    expect(screen.getByTestId(`rf__node-${intent.id}`)).toHaveStyle({ visibility: 'visible' });
    expect(screen.getByTestId('rf__node-proposal::specialist:reasoning')).toHaveStyle({ visibility: 'visible' });
  });

  it('registers real intent-to-proposal traceability edges and connectable intent handles', async () => {
    render(
      <div style={{ width: 1_000, height: 700 }}>
        <GraphCanvas
          nodes={[intent]}
          edges={[]}
          proposedGraph={proposedGraph}
          onSelectNode={vi.fn()}
          onSelectProposalNode={vi.fn()}
          onPositionChange={vi.fn()}
          onConnectNodes={vi.fn()}
        />
      </div>,
    );

    await waitFor(() => expect(
      [...document.querySelectorAll('marker')].some((marker) => marker.id.includes('color=#6c8f97')),
    ).toBe(true));
    expect(screen.getByLabelText('Outgoing relation')).toHaveClass('connectable', 'connectionindicator');
  });

  it('moves only the dragged intent and keeps every proposal at its existing graph coordinate', async () => {
    const user = userEvent.setup();
    const bounds = {
      x: 0, y: 0, left: 0, top: 0, right: 1_000, bottom: 700, width: 1_000, height: 700,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);

    function ControlledGraph() {
      const [intentNodes, setIntentNodes] = useState([intent]);
      return (
        <>
          <button
            type="button"
            onClick={() => setIntentNodes((current) => [...current, {
              ...intent,
              id: 'intent:second',
              title: 'Second intent',
              position: { x: 420, y: 80 },
            }])}
          >
            Add second intent
          </button>
          <div style={{ width: 1_000, height: 700 }}>
            <GraphCanvas
              graphId="graph:stable-interaction-test"
              nodes={intentNodes}
              edges={[]}
              proposedGraph={proposedGraph}
              onSelectNode={vi.fn()}
              onSelectProposalNode={vi.fn()}
              onPositionChange={(nodeId, position) => setIntentNodes((current) => current.map((node) => (
                node.id === nodeId ? { ...node, position } : node
              )))}
              onConnectNodes={vi.fn()}
            />
          </div>
        </>
      );
    }

    render(<ControlledGraph />);
    await waitFor(() => expect(document.querySelector('.react-flow__viewport')).toBeInTheDocument());
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    const proposalNode = screen.getByTestId('rf__node-proposal::specialist:reasoning');
    const proposalTransform = proposalNode.style.transform;
    const intentNode = screen.getByTestId(`rf__node-${intent.id}`);
    const intentTransform = intentNode.style.transform;
    const viewportTransform = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;

    dragNode(intentNode, { x: 120, y: 120 }, { x: 390, y: 310 });
    await waitFor(() => expect(screen.getByTestId(`rf__node-${intent.id}`).style.transform).not.toBe(intentTransform));
    expect(screen.getByTestId('rf__node-proposal::specialist:reasoning').style.transform).toBe(proposalTransform);

    await user.click(screen.getByRole('button', { name: 'Add second intent' }));
    await waitFor(() => expect(screen.getByTestId('rf__node-intent:second')).toBeInTheDocument());
    expect(screen.getByTestId('rf__node-proposal::specialist:reasoning').style.transform).toBe(proposalTransform);
    expect(document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform).toBe(viewportTransform);
  });
});

function dragNode(node: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const mouseEvent = (type: string, init: MouseEventInit) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, 'view', { value: window });
    return event;
  };
  fireEvent(node, mouseEvent('mousedown', { button: 0, buttons: 1, clientX: from.x, clientY: from.y }));
  fireEvent(window, mouseEvent('mousemove', { buttons: 1, clientX: to.x, clientY: to.y }));
  fireEvent(window, mouseEvent('mouseup', { button: 0, buttons: 0, clientX: to.x, clientY: to.y }));
}
