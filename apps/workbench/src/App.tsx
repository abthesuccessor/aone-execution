import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Callout,
  Flex,
  Heading,
  Select,
  Tabs,
  Text,
  TextField,
  Theme,
  Tooltip,
} from '@radix-ui/themes';
import {
  IconAlertCircle,
  IconActivity,
  IconArrowsDiff,
  IconBolt,
  IconBrandDatabricks,
  IconDeviceFloppy,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconRoute,
  IconX,
  IconLayoutSidebarLeftCollapse, IconLayoutSidebarRightCollapse, IconLayoutBottombarCollapse, IconSearch, IconArrowBackUp, IconArrowForwardUp, IconPlayerStop, IconAdjustments,
} from '@tabler/icons-react';
import { api } from './lib/api';
import { newTopicNode } from './lib/templates';
import type {
  Artifact,
  ConnectProviderConnectionInput,
  DiscoverProviderConnectionInput,
  EngineeringAgent,
  EngineeringGraph,
  ExecutionEvent,
  ExecutionRun,
  PlanVersion,
  ProviderConnectionResult,
  ProviderStatus,
  RetrievalHit,
  SourceRecord,
  TraceStreamEvent,
  TopicNode,
} from './lib/types';
import { useGraphTraceStream } from './lib/useGraphTraceStream';
import { useExecutionStream } from './lib/useExecutionStream';
import { NodeInspector } from './components/NodeInspector';
import { NodeLibrary, type NewNodeRequest } from './components/NodeLibrary';
import { ProposalInspector, PROPOSAL_REFINEMENT_LIMIT } from './components/ProposalInspector';
import { LIVE_WEB_RESEARCH_CAPABILITY, ResearchPolicyControl } from './components/ResearchPolicyControl';
import { ResizableWorkbench } from './components/ResizableWorkbench';
import { ProviderSettings } from './components/ProviderSettings';
import { CatalogPanel } from './components/CatalogPanel';
import { EngineeringSettingsDialog, type EngineeringSettingsTab } from './components/EngineeringSettingsDialog';
import { ChatPanel } from './components/ChatPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { ActivityBar, CommandPalette, type EditorView, type WorkbenchCommand } from './components/WorkspaceChrome';
import { RelationsPanel } from './components/RelationsPanel';
import { NodeConfiguration } from './components/NodeConfiguration';
import { NodeReferences } from './components/NodeReferences';
import { HarnessPanel } from './components/HarnessPanel';
import { SuggestionReview } from './components/SuggestionReview';
import { useHarnessOptions } from './lib/useHarnessOptions';
import { previewRelations } from './lib/graph-editing';
import { projectExecutionDisplay } from './lib/execution-display';
import './workbench.css';
import { CreateWorkspaceDialog, WorkspaceControls } from './components/WorkspaceControls';
import { Button as DesktopActionButton } from './components/ui/button';
import { Separator } from './components/ui/separator';

const PlanPanel = lazy(() => import('./components/PlanPanel').then((module) => ({ default: module.PlanPanel })));
const ExecutionPanel = lazy(() => import('./components/ExecutionPanel').then((module) => ({ default: module.ExecutionPanel })));
const TracePanel = lazy(() => import('./components/TracePanel').then((module) => ({ default: module.TracePanel })));
const GraphCanvas = lazy(() => import('./components/GraphCanvas').then((module) => ({ default: module.GraphCanvas })));

type BusyAction = 'save' | 'plan' | 'approve' | 'execute' | 'pause' | 'resume-original' | 'create' | 'switch-workspace' | 'rename-workspace' | 'rebind-workspace' | 'delete-workspace' | 'create-node' | 'upload' | undefined;

export function App() {
  const [graphs, setGraphs] = useState<EngineeringGraph[]>([]);
  const [graph, setGraph] = useState<EngineeringGraph>();
  const [harnessOptions, setHarnessOptions] = useHarnessOptions(graph?.id);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [agents, setAgents] = useState<EngineeringAgent[]>([]);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [providerId, setProviderId] = useState<string>(() => readPreference('provider', ''));
  useEffect(() => { storePreference('provider', providerId); }, [providerId]);
  const [plans, setPlans] = useState<PlanVersion[]>([]);
  const [executions, setExecutions] = useState<ExecutionRun[]>([]);
  const [activePlan, setActivePlan] = useState<PlanVersion>();
  const [activeExecution, setActiveExecution] = useState<ExecutionRun>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedProposalNodeId, setSelectedProposalNodeId] = useState<string>();
  const [graphFocusRequest, setGraphFocusRequest] = useState<{ nodeId: string; sequence: number }>();
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [retrievalHits, setRetrievalHits] = useState<RetrievalHit[]>([]);
  const [approvalContext, setApprovalContext] = useState('');
  const [planningContext, setPlanningContext] = useState('');
  const [liveResearchEnabled, setLiveResearchEnabled] = useState(false);
  const [bottomTab, setBottomTabValue] = useState('plan');
  const [panels, setPanels] = useState<{left: boolean; right: boolean; bottom: boolean}>(() => readPreference('panels', { left: false, right: false, bottom: true }));
  const [editorView, setEditorView] = useState<EditorView>('graph');
  const [commandOpen, setCommandOpen] = useState(false);
  const [engineeringSettingsOpen, setEngineeringSettingsOpen] = useState(false);
  const [engineeringSettingsTab, setEngineeringSettingsTab] = useState<EngineeringSettingsTab>('skills');
  const openEngineeringSettings = (tab: EngineeringSettingsTab = 'skills') => { setEngineeringSettingsTab(tab); setEngineeringSettingsOpen(true); };
  const [layoutResetKey, setLayoutResetKey] = useState(0);
  const [nodeSearch, setNodeSearch] = useState('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [showMinimap, setShowMinimap] = useState(() => readPreference('minimap', false));
  const [actionRequest, setActionRequest] = useState<{id: string; action: 'discuss' | 'refine' | 'fact-check' | 'develop'; nodeIds: string[]; prompt?: string}>();
  const [runScope, setRunScope] = useState<string[]>([]);
  const undoStack = useRef<EngineeringGraph[]>([]);
  const redoStack = useRef<EngineeringGraph[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const setBottomTab = (tab: string) => { setBottomTabValue(tab); setPanels((current) => ({ ...current, bottom: false })); };
  useEffect(() => { storePreference('panels', panels); }, [panels]);
  useEffect(() => { storePreference('minimap', showMinimap); }, [showMinimap]);
  const [dirty, setDirty] = useState(false);
  const [replanFailed, setReplanFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [retrievalLoading, setRetrievalLoading] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [traceEvents, setTraceEvents] = useState<TraceStreamEvent[]>([]);
  const [traceStreamConnected, setTraceStreamConnected] = useState(false);
  const [busy, setBusy] = useState<BusyAction>();
  const [draftSaving, setDraftSaving] = useState(false);
  const [chatDraftLocked, setChatDraftLocked] = useState(false);
  const uiBusy = busy !== undefined || draftSaving || chatDraftLocked;
  const [error, setError] = useState<string>();
  const [sourcesError, setSourcesError] = useState<string>();
  const [retrievalError, setRetrievalError] = useState<string>();

  const executionDisplay = useMemo(() => projectExecutionDisplay(graph?.nodes ?? [], activePlan, activeExecution, events), [graph?.nodes, activePlan, activeExecution, events]);
  const displayNodes = useMemo(() => graph?.nodes.map((node) => ({ ...node, status: executionDisplay.intentStatuses[node.id] ?? 'draft' })) ?? [], [graph?.nodes, executionDisplay]);
  const selectedNode = displayNodes.find((node) => node.id === selectedNodeId);
  const selectedNodeSources = sources.filter((source) => source.nodeId === selectedNodeId);
  const selectedProposalNode = activePlan?.proposedGraph?.nodes.find((node) => node.id === selectedProposalNodeId);
  const selectedProposalIntentIds = new Set(selectedProposalNode?.traceability?.intentNodeIds ?? []);
  const selectedProposalSourceIntents = graph?.nodes.filter((node) => (
    selectedProposalIntentIds.has(node.id)
  )) ?? [];
  const previousPlan = activePlan?.previousPlanId
    ? plans.find((plan) => plan.id === activePlan.previousPlanId)
    : activePlan && activePlan.version > 1
      ? [...plans].sort((a, b) => b.version - a.version).find((plan) => plan.version < activePlan.version)
      : undefined;
  const nextPlanVersion = plans.reduce((maximum, plan) => Math.max(maximum, plan.version), 0) + 1;
  const canEdit = !uiBusy && activeExecution?.status !== 'running'
    && activeExecution?.status !== 'queued'
    && activeExecution?.status !== 'pause_requested'
    && activeExecution?.status !== 'cancel_requested';
  const isPaused = activeExecution?.status === 'paused';
  const isReplanned = Boolean(isPaused && activePlan && activePlan.id !== activeExecution?.planId);
  const planApproved = activePlan?.status === 'approved';
  const planStale = Boolean(
    activePlan
    && graph?.draftRevision !== undefined
    && activePlan.baseDraftRevision !== undefined
    && activePlan.baseDraftRevision !== graph.draftRevision,
  );
  const runtimeProviders = useMemo(() => providers.filter(isUserRuntimeProvider), [providers]);
  const provider = runtimeProviders.find((item) => item.id === providerId);
  const activeRuntimeCanExecute = Boolean(
    providers.find((item) => item.id === activePlan?.provider)?.capabilities?.includes('execute'),
  );
  const liveResearchSupported = providerId === 'codex-cli'
    && (provider?.capabilities?.includes(LIVE_WEB_RESEARCH_CAPABILITY) ?? false);
  const activePlanResearchEnabled = Boolean(activePlan?.researchPolicy?.enabled);
  const planningSettingsStale = Boolean(activePlan && (
    providerId !== activePlan.provider || liveResearchEnabled !== activePlanResearchEnabled
    || (activePlan.engineeringProfile !== undefined && (activePlan.engineeringProfile !== harnessOptions.profile || activePlan.engineeringConventions !== harnessOptions.conventions))
  ));
  const hasApprovedSuccessor = Boolean(
    isPaused && isReplanned && planApproved && !planStale && !planningSettingsStale && !dirty,
  );
  const workspaceDeleteBlockedReason = activeExecution && ['queued', 'running', 'pause_requested', 'cancel_requested'].includes(activeExecution.status)
    ? 'Pause or finish the active execution before deleting this workspace.'
    : undefined;
  const workspaceRebindBlockedReason = activeExecution && ['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'].includes(activeExecution.status)
    ? 'Finish or supersede the active execution before changing its project folder.'
    : undefined;

  const showEdges = useMemo(() => graph?.edges ?? [], [graph]);

  const loadGraph = useCallback(async (graphId: string) => {
    setLoading(true);
    setSourcesLoading(true);
    setError(undefined);
    setSourcesError(undefined);
    try {
      const [bundleResult, sourcesResult] = await Promise.allSettled([
        api.getGraphBundle(graphId),
        api.listSources(graphId),
      ]);
      if (bundleResult.status === 'rejected') throw bundleResult.reason;
      const bundle = bundleResult.value;
      if (sourcesResult.status === 'fulfilled') {
        setSources(sourcesResult.value);
      } else {
        setSources([]);
        setSourcesError(messageFrom(sourcesResult.reason));
      }
      setGraph(bundle.graph);
      setPlans(bundle.plans);
      setExecutions(bundle.executions);
      const latestUsablePlan = [...bundle.plans]
        .filter((plan) => plan.status !== 'superseded')
        .sort((a, b) => b.version - a.version)[0];
      const latestExecution = [...bundle.executions].sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))[0];
      setActiveExecution(undefined);
      setSelectedNodeId(bundle.graph.nodes[0]?.id);
      setSelectedNodeIds(bundle.graph.nodes[0] ? [bundle.graph.nodes[0].id] : []);
      setRunScope([]); setActionRequest(undefined); setCollapsedGroups([]);
      undoStack.current = []; redoStack.current = []; setHistoryVersion((value) => value + 1);
      setSelectedProposalNodeId(undefined);
      setApprovalContext('');
      setPlanningContext('');
      setBottomTabValue('plan');
      setEvents([]);
      setTraceEvents([]);
      setArtifacts([]);
      setDirty(false);
      setReplanFailed(false);
      setRetrievalHits([]);
      setRetrievalError(undefined);
      let selectedPlan = latestUsablePlan;
      if (latestExecution) {
        const snapshot = await api.getExecutionHistory(latestExecution.id).catch(() => undefined);
        if (snapshot) {
          setEvents(snapshot.events);
          setArtifacts(snapshot.artifacts);
          setActiveExecution(snapshot.execution);
          const executionIsActive = ['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'].includes(snapshot.execution.status);
          if (snapshot.execution.status === 'paused' && snapshot.execution.pendingPlanId) {
            selectedPlan = bundle.plans.find((plan) => (
              plan.id === snapshot.execution.pendingPlanId && plan.status !== 'superseded'
            )) ?? snapshot.plan ?? selectedPlan;
          } else if (executionIsActive) {
            selectedPlan = snapshot.plan
              ?? bundle.plans.find((plan) => plan.id === snapshot.execution.planId)
              ?? selectedPlan;
          }
        } else {
          const loadedArtifacts = await api.listArtifacts(latestExecution.id).catch(() => []);
          setArtifacts(loadedArtifacts);
          setActiveExecution(latestExecution);
          const executionIsActive = ['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'].includes(latestExecution.status);
          if (latestExecution.status === 'paused' && latestExecution.pendingPlanId) {
            selectedPlan = bundle.plans.find((plan) => (
              plan.id === latestExecution.pendingPlanId && plan.status !== 'superseded'
            )) ?? selectedPlan;
          } else if (executionIsActive) {
            selectedPlan = bundle.plans.find((plan) => plan.id === latestExecution.planId) ?? selectedPlan;
          }
        }
      }
      setActivePlan(selectedPlan);
      if (selectedPlan) {
        setLiveResearchEnabled(Boolean(selectedPlan.researchPolicy?.enabled));
      } else {
        setLiveResearchEnabled(false);
      }
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
      setSourcesLoading(false);
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const [graphsResult, providersResult, agentsResult] = await Promise.allSettled([
      api.listGraphs(),
      api.listProviders(),
      api.listAgents(),
    ]);

    if (providersResult.status === 'fulfilled') {
      setProviders(providersResult.value);
      const preferred = providersResult.value.find((item) => isUserRuntimeProvider(item) && isProviderReady(item));
      if (preferred) setProviderId((current) => providersResult.value.some((item) => item.id === current && isProviderReady(item)) ? current : preferred.id);
    }
    if (agentsResult.status === 'fulfilled') {
      setAgents(agentsResult.value.agents);
    }

    if (graphsResult.status === 'rejected') {
      setError(messageFrom(graphsResult.reason));
      setLoading(false);
      return;
    }

    setGraphs(graphsResult.value);
    if (graphsResult.value.length > 0) {
      await loadGraph(graphsResult.value[0].id);
    } else {
      setGraph(undefined);
      setLoading(false);
    }
  }, [loadGraph]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => {
    setRetrievalHits([]);
    setRetrievalError(undefined);
  }, [selectedNodeId]);
  useEffect(() => {
    if (selectedProposalNodeId && !activePlan?.proposedGraph?.nodes.some((node) => node.id === selectedProposalNodeId)) {
      setSelectedProposalNodeId(undefined);
    }
  }, [activePlan, selectedProposalNodeId]);
  useEffect(() => {
    if (!activePlan) return;
    setLiveResearchEnabled(Boolean(activePlan.researchPolicy?.enabled));
  }, [activePlan?.id, activePlan?.provider, activePlan?.researchPolicy?.enabled]);
  useEffect(() => {
    if (!liveResearchSupported) setLiveResearchEnabled(false);
  }, [liveResearchSupported]);

  const refreshArtifacts = useCallback(async (executionId: string) => {
    const next = await api.listArtifacts(executionId).catch(() => []);
    setArtifacts(next);
  }, []);

  const handleExecutionEvent = useCallback((event: ExecutionEvent) => {
    setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
    const statusByEvent: Record<string, ExecutionRun['status']> = {
      'execution.started': 'running',
      'execution.resumed': 'running',
      'execution.pause_requested': 'pause_requested',
      'execution.paused': 'paused',
      'execution.completed': 'completed',
      'execution.failed': 'failed',
      'execution.superseded': 'stopped',
      'execution.cancel_requested': 'cancel_requested',
      'execution.cancelled': 'cancelled',
    };
    const recoveredStatus = event.type === 'execution.recovered' && event.data?.status
      ? String(event.data.status).toLowerCase() as ExecutionRun['status']
      : undefined;
    if (statusByEvent[event.type] || recoveredStatus) {
      setActiveExecution((current) => {
        if (!current || (event.executionId && event.executionId !== current.id)) return current;
        if (['cancelled', 'failed', 'completed', 'superseded', 'stopped'].includes(current.status)) return current;
        return { ...current, status: recoveredStatus ?? statusByEvent[event.type] };
      });
    }
    if (event.type === 'artifact.created' && event.executionId) void refreshArtifacts(event.executionId);
  }, [refreshArtifacts]);

  useExecutionStream({
    executionId: activeExecution && ['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'].includes(activeExecution.status) ? activeExecution.id : undefined,
    initialCursor: events.at(-1)?.cursor,
    onEvent: handleExecutionEvent,
    onConnectionChange: setStreamConnected,
  });

  const handleTraceEvent = useCallback((event: TraceStreamEvent) => {
    setTraceEvents((current) => {
      if (current.some((item) => item.id === event.id)) return current;
      return [...current.slice(-499), event];
    });
  }, []);

  useGraphTraceStream({
    graphId: graph?.id,
    initialCursor: traceEvents.at(-1)?.cursor,
    onEvent: handleTraceEvent,
    onConnectionChange: setTraceStreamConnected,
  });

  const persistCurrentDraftBeforeLeaving = async () => {
    if (!graph || !dirty) return graph;
    setDraftSaving(true);
    try {
      const saved = await api.saveGraph(graph);
      setGraph(saved);
      setGraphs((current) => current.map((item) => item.id === saved.id
        ? { ...item, name: saved.name, updatedAt: saved.updatedAt }
        : item));
      setDirty(false);
      return saved;
    } finally { setDraftSaving(false); }
  };

  const createWorkspace = async (name: string, workspacePath?: string) => {
    setBusy('create');
    setError(undefined);
    try {
      await persistCurrentDraftBeforeLeaving();
      const created = await api.createGraph(name.trim() || 'Untitled workspace', workspacePath);
      setGraphs((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      await loadGraph(created.id);
    } catch (cause) {
      setError(messageFrom(cause));
      throw cause;
    } finally {
      setBusy(undefined);
    }
  };

  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === graph?.id) return;
    setBusy('switch-workspace');
    setError(undefined);
    try {
      await persistCurrentDraftBeforeLeaving();
      await loadGraph(workspaceId);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const renameWorkspace = async (name: string) => {
    if (!graph) return;
    setBusy('rename-workspace');
    setError(undefined);
    try {
      const renamed = await api.renameWorkspace(graph.id, name.trim());
      setGraph((current) => current?.id === renamed.id
        ? { ...current, name: renamed.name, updatedAt: renamed.updatedAt }
        : current);
      setGraphs((current) => current.map((item) => item.id === renamed.id
        ? { ...item, name: renamed.name, updatedAt: renamed.updatedAt }
        : item));
    } catch (cause) {
      setError(messageFrom(cause));
      throw cause;
    } finally {
      setBusy(undefined);
    }
  };

  const rebindWorkspace = async (workspacePath: string) => {
    if (!graph || !workspacePath.trim()) return;
    if (workspaceRebindBlockedReason) {
      const cause = new Error(workspaceRebindBlockedReason);
      setError(cause.message);
      throw cause;
    }
    setBusy('rebind-workspace');
    setError(undefined);
    try {
      await persistCurrentDraftBeforeLeaving();
      const rebound = await api.updateWorkspacePath(graph.id, workspacePath.trim());
      setGraphs((current) => current.map((item) => item.id === rebound.id
        ? { ...item, workspacePath: rebound.workspacePath, updatedAt: rebound.updatedAt }
        : item));
      await loadGraph(graph.id);
    } catch (cause) {
      setError(messageFrom(cause));
      throw cause;
    } finally {
      setBusy(undefined);
    }
  };

  const deleteWorkspace = async () => {
    if (!graph) return;
    if (workspaceDeleteBlockedReason) {
      const cause = new Error(workspaceDeleteBlockedReason);
      setError(cause.message);
      throw cause;
    }
    const deletedId = graph.id;
    const remaining = graphs.filter((item) => item.id !== deletedId);
    setBusy('delete-workspace');
    setError(undefined);
    try {
      await api.deleteWorkspace(deletedId);
      setGraphs(remaining);
      if (remaining.length > 0) {
        await loadGraph(remaining[0].id);
      } else {
        setGraph(undefined);
        setPlans([]);
        setExecutions([]);
        setActivePlan(undefined);
        setActiveExecution(undefined);
        setSelectedNodeId(undefined);
        setSelectedProposalNodeId(undefined);
        setEvents([]);
        setTraceEvents([]);
        setArtifacts([]);
        setSources([]);
        setRetrievalHits([]);
        setApprovalContext('');
        setPlanningContext('');
        setLiveResearchEnabled(false);
        setBottomTab('plan');
        setDirty(false);
        setReplanFailed(false);
        setStreamConnected(false);
        setTraceStreamConnected(false);
        setSourcesError(undefined);
        setRetrievalError(undefined);
        setLoading(false);
      }
    } catch (cause) {
      setError(messageFrom(cause));
      throw cause;
    } finally {
      setBusy(undefined);
    }
  };

  const rememberGraph = () => {
    if (!graph) return;
    undoStack.current = [...undoStack.current.slice(-49), structuredClone(graph)];
    redoStack.current = []; setHistoryVersion((value) => value + 1);
  };
  const updateGraph = (updater: (value: EngineeringGraph) => EngineeringGraph) => {
    if (!graph || !canEdit) return;
    rememberGraph(); setGraph(updater(graph)); setDirty(true);
  };
  const undoGraph = (redo = false) => {
    if (!graph || !canEdit) return;
    const from = redo ? redoStack : undoStack; const to = redo ? undoStack : redoStack;
    const previous = from.current.pop(); if (!previous) return;
    to.current.push(structuredClone(graph));
    setGraph({ ...previous, draftRevision: graph.draftRevision }); setDirty(true); setHistoryVersion((value) => value + 1);
  };

  const connectDraftNodes = (sourceNodeId: string, targetNodeId: string) => {
    if (!graph || !canEdit || sourceNodeId === targetNodeId) return;
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    if (!nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId)) return;
    if (!previewRelations(graph.nodes, graph.edges, [sourceNodeId], [targetNodeId], 'RELATED_TO').pairs.length) return;
    updateGraph((current) => ({
      ...current,
      edges: [...current.edges, {
        id: crypto.randomUUID(),
        source: sourceNodeId,
        target: targetNodeId,
        type: 'RELATED_TO', label: '', rationale: '',
      }],
    }));
  };

  const addNode = async ({ files, ...input }: NewNodeRequest): Promise<boolean> => {
    if (!graph || !canEdit) return false;
    const node = newTopicNode(input, graph.nodes.length);
    rememberGraph();
    const nextGraph = { ...graph, nodes: [...graph.nodes, node] };
    if (files.length === 0) {
      setGraph(nextGraph);
      setDirty(true);
      setSelectedNodeId(node.id); setSelectedNodeIds([node.id]);
      setSelectedProposalNodeId(undefined);
      return true;
    }

    setBusy('create-node');
    setError(undefined);
    try {
      const saved = await api.saveGraph(nextGraph);
      setGraph(saved);
      setGraphs((current) => current.map((item) => item.id === saved.id ? { ...item, name: saved.name, updatedAt: saved.updatedAt } : item));
      setDirty(false);
      setSelectedNodeId(node.id); setSelectedNodeIds([node.id]);
      setSelectedProposalNodeId(undefined);
      const uploaded = await uploadSourceFiles(saved.id, node.id, files);
      setSources((current) => [...uploaded.items, ...current.filter((source) => !uploaded.items.some((item) => item.id === source.id))]);
      if (uploaded.errors.length > 0) setError(uploaded.errors.join(' '));
      return true;
    } catch (cause) {
      setError(messageFrom(cause));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const updateSelectedNode = (patch: Partial<TopicNode>) => {
    if (!selectedNodeId || !canEdit) return;
    updateGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === selectedNodeId ? { ...node, ...patch } : node),
    }));
  };

  const removeSelectedNode = () => {
    if (!selectedNodeId || !canEdit) return;
    updateGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== selectedNodeId),
      edges: current.edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId),
    }));
    setSelectedNodeIds((current) => current.filter((id) => id !== selectedNodeId));
    setSelectedNodeId(undefined);
  };

  const uploadSelectedNodeSources = async (files: File[]) => {
    if (!graph || !selectedNodeId || !canEdit || files.length === 0) return;
    setBusy('upload');
    setError(undefined);
    setSourcesError(undefined);
    try {
      const saved = await api.saveGraph(graph);
      setGraph(saved);
      setSelectedNodeId((current) => retainedNodeSelection(current, saved));
      setGraphs((current) => current.map((item) => item.id === saved.id ? { ...item, name: saved.name, updatedAt: saved.updatedAt } : item));
      setDirty(false);
      const uploaded = await uploadSourceFiles(saved.id, selectedNodeId, files);
      setSources((current) => [...uploaded.items, ...current.filter((source) => !uploaded.items.some((item) => item.id === source.id))]);
      if (uploaded.errors.length > 0) setError(uploaded.errors.join(' '));
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const searchSources = async (query: string) => {
    if (!graph || !query.trim()) return;
    setRetrievalLoading(true);
    setRetrievalError(undefined);
    try {
      setRetrievalHits(await api.retrieveSources(graph.id, query.trim(), 8));
    } catch (cause) {
      setRetrievalHits([]);
      setRetrievalError(messageFrom(cause));
    } finally {
      setRetrievalLoading(false);
    }
  };

  const saveDraft = async (): Promise<EngineeringGraph | undefined> => {
    if (!graph) return undefined;
    setBusy('save');
    setError(undefined);
    try {
      const saved = await api.saveGraph(graph);
      setGraph(saved);
      setSelectedNodeId((current) => retainedNodeSelection(current, saved));
      setGraphs((current) => current.map((item) => item.id === saved.id ? { ...item, name: saved.name, updatedAt: saved.updatedAt } : item));
      setDirty(false);
      return saved;
    } catch (cause) {
      setError(messageFrom(cause));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const requestPlan = async () => {
    if (!graph || graph.nodes.length === 0) return;
    if (!provider || !isProviderReady(provider)) {
      setError('Connect and select an available AI, LLM, or CLI runtime before requesting proposal nodes.');
      return;
    }
    setBusy('plan');
    setError(undefined);
    setReplanFailed(false);
    try {
      if (dirty && !isPaused) {
        const saved = await api.saveGraph(graph);
        setGraph(saved);
        setSelectedNodeId((current) => retainedNodeSelection(current, saved));
        setDirty(false);
      }
      const plan = isPaused && activeExecution
        ? (await api.replanExecution(activeExecution.id, {
            provider: providerId,
            additionalContext: planningContext,
            engineeringProfile: harnessOptions.profile,
            conventions: harnessOptions.conventions,
            research: { enabled: liveResearchEnabled },
          }, dirty ? graph : undefined)).plan
        : await api.createPlan(graph.id, {
            provider: providerId,
            additionalContext: planningContext,
            engineeringProfile: harnessOptions.profile,
            conventions: harnessOptions.conventions,
            previousPlanId: activePlan?.id,
            research: { enabled: liveResearchEnabled },
          });
      if (isPaused && dirty) {
        setGraph((current) => current ? { ...current, draftRevision: (current.draftRevision ?? 0) + 1 } : current);
        setDirty(false);
      }
      setPlans((current) => [...current.filter((item) => item.id !== plan.id), plan]);
      setActivePlan(plan);
      setApprovalContext('');
      setBottomTab('plan');
    } catch (cause) {
      if (isPaused) setReplanFailed(true);
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const refineProposalNode = async (request: string): Promise<boolean> => {
    if (!graph || !activePlan || !selectedProposalNode || !canEdit) return false;
    if (!provider || !isProviderReady(provider)) {
      setError('Connect and select an available AI, LLM, or CLI runtime before refining proposal nodes.');
      return false;
    }
    const normalizedRequest = request.trim();
    if (!normalizedRequest || normalizedRequest.length > PROPOSAL_REFINEMENT_LIMIT) {
      setError(`A refinement request must contain 1 to ${PROPOSAL_REFINEMENT_LIMIT} characters.`);
      return false;
    }
    const linkedIntentIds = new Set(selectedProposalNode.traceability?.intentNodeIds ?? []);
    const linkedIntents = graph.nodes.filter((node) => linkedIntentIds.has(node.id));
    if (linkedIntents.length === 0) {
      setError('This proposal has no linked intent in the current draft, so it cannot be refined safely.');
      return false;
    }

    let contextChanged = false;
    const refinedGraph: EngineeringGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => {
        if (!linkedIntentIds.has(node.id)) return node;
        const context = appendProposalRefinement(node.context, activePlan.version, selectedProposalNode.title, normalizedRequest);
        if (context !== node.context) contextChanged = true;
        return { ...node, context };
      }),
    };
    const targetedPlanningContext = [
      planningContext.trim(),
      `Recompile proposal node ${selectedProposalNode.id} from its persisted linked intent context.`,
      `Requested refinement: ${normalizedRequest}`,
    ].filter(Boolean).join('\n\n');

    setBusy('plan');
    setError(undefined);
    setReplanFailed(false);
    try {
      let plan: PlanVersion;
      if (isPaused && activeExecution) {
        plan = (await api.replanExecution(
          activeExecution.id,
          {
            provider: providerId,
            additionalContext: targetedPlanningContext,
            research: { enabled: liveResearchEnabled },
          },
          refinedGraph,
        )).plan;
        setGraph({
          ...refinedGraph,
          draftRevision: plan.baseDraftRevision ?? (graph.draftRevision ?? 0) + 1,
        });
      } else {
        const persistedGraph = contextChanged || dirty ? await api.saveGraph(refinedGraph) : refinedGraph;
        setGraph(persistedGraph);
        setGraphs((current) => current.map((item) => item.id === persistedGraph.id
          ? { ...item, name: persistedGraph.name, updatedAt: persistedGraph.updatedAt }
          : item));
        setDirty(false);
        plan = await api.createPlan(persistedGraph.id, {
          provider: providerId,
          additionalContext: targetedPlanningContext,
          previousPlanId: activePlan.id,
          research: { enabled: liveResearchEnabled },
        });
      }
      setDirty(false);
      setPlans((current) => [...current.filter((item) => item.id !== plan.id), plan]);
      setActivePlan(plan);
      setApprovalContext('');
      setBottomTab('plan');
      return true;
    } catch (cause) {
      if (isPaused) setReplanFailed(true);
      setError(messageFrom(cause));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const resumeOriginalPlan = async () => {
    if (!graph || !activeExecution || !isPaused) return;
    setBusy('resume-original');
    setError(undefined);
    try {
      const canonicalGraph = dirty ? await api.getGraph(graph.id) : graph;
      const resumed = await api.resumeOriginalExecution(activeExecution.id);
      setGraph(canonicalGraph);
      setDirty(false);
      setReplanFailed(false);
      const pinnedPlan = plans.find((plan) => plan.id === activeExecution.planId);
      if (pinnedPlan) setActivePlan(pinnedPlan);
      setPlans((current) => current.map((plan) => plan.id === activePlan?.id && plan.id !== activeExecution.planId
        ? { ...plan, status: 'superseded' }
        : plan));
      setActiveExecution(resumed.execution);
      setExecutions((current) => current.map((item) => item.id === resumed.execution.id ? resumed.execution : item));
      setBottomTab('execution');
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const approvePlan = async () => {
    if (!graph || !activePlan) return;
    setBusy('approve');
    setError(undefined);
    try {
      const approved = await api.approvePlan(graph.id, activePlan.id, activePlan.contentHash, approvalContext);
      setActivePlan(approved);
      setPlans((current) => current.map((item) => item.id === approved.id ? approved : item));
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const startOrContinue = async (nodeIds = runScope) => {
    if (!graph || !activePlan || !planApproved) return;
    setBusy('execute');
    setError(undefined);
    try {
      const resumed = isPaused && activeExecution ? await api.resumeExecution(activeExecution.id) : undefined;
      const next = resumed?.execution
        ?? await api.startExecution(graph.id, {
          planId: activePlan.id,
          expectedPlanHash: activePlan.contentHash,
          provider: activePlan.provider, nodeIds: nodeIds.length ? nodeIds : undefined,
        });
      setActiveExecution(next);
      setExecutions((current) => {
        const withPredecessor = resumed?.predecessor
          ? current.map((item) => item.id === resumed.predecessor?.id ? resumed.predecessor : item)
          : current;
        return [...withPredecessor.filter((item) => item.id !== next.id), next];
      });
      setEvents([]);
      setArtifacts([]);
      setBottomTab('execution');
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const pauseExecution = async () => {
    if (!activeExecution) return;
    setBusy('pause');
    setError(undefined);
    try {
      const paused = await api.pauseExecution(activeExecution.id);
      setActiveExecution(paused);
      setExecutions((current) => current.map((item) => item.id === paused.id ? paused : item));
      setBottomTab('execution');
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const applyProviderResult = (result: ProviderConnectionResult): ProviderConnectionResult => {
    const updated = result.provider;
    if (!updated) return result;
    setProviders((current) => {
      const next = current.some((item) => item.id === updated.id)
        ? current.map((item) => item.id === updated.id ? updated : item)
        : [...current, updated];
      const fallback = next.find((item) => isUserRuntimeProvider(item) && isProviderReady(item));
      setProviderId((selected) => {
        if (isUserRuntimeProvider(updated) && isProviderReady(updated)
          && (!selected || !next.some((item) => item.id === selected && isUserRuntimeProvider(item) && isProviderReady(item)))) {
          return updated.id;
        }
        if (selected === updated.id && !isProviderReady(updated)) return fallback?.id ?? '';
        return selected;
      });
      return next;
    });
    return result;
  };

  const discoverProvider = async (input: DiscoverProviderConnectionInput) => (
    applyProviderResult(await api.discoverProviderConnection(input))
  );

  const connectProvider = async (input: ConnectProviderConnectionInput) => (
    applyProviderResult(await api.connectProvider(input))
  );

  const refreshProviderModels = async (profileId: string) => (
    applyProviderResult(await api.listProviderModels(profileId))
  );

  const disconnectProvider = async (profileId: string) => (
    applyProviderResult(await api.disconnectProvider(profileId))
  );

  const selectIntent = (id?: string) => { setSelectedNodeId(id); setSelectedNodeIds(id ? [id] : []); setSelectedProposalNodeId(undefined); };
  const chatNodeIds = selectedProposalNode ? selectedProposalSourceIntents.map((node) => node.id) : selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : [];
  const groups = [...new Set(graph?.nodes.map((node) => node.group).filter((value): value is string => Boolean(value)) ?? [])];
  const refreshCatalogs = async () => { try { const result = await api.listAgents(); setAgents(result.agents); } catch (cause) { setError(messageFrom(cause)); } finally { setCatalogVersion((value) => value + 1); } };
  const refreshAppliedGraph = async () => {
    if (!graph) return;
    const bundle = await api.getGraphBundle(graph.id);
    setGraph(bundle.graph); setPlans(bundle.plans); setDirty(false);
    undoStack.current = []; redoStack.current = []; setHistoryVersion((value) => value + 1);
  };
  const beginChat = async (action: 'discuss' | 'refine' | 'fact-check' | 'develop', ids = chatNodeIds, prompt?: string) => {
    try { await persistCurrentDraftBeforeLeaving(); setPanels((value) => ({ ...value, right: false })); setActionRequest({ id: crypto.randomUUID(), action, nodeIds: ids, prompt }); }
    catch (cause) { setError(messageFrom(cause)); }
  };
  const runSelection = async () => {
    const ids = selectedProposalNodeId ? [selectedProposalNodeId] : chatNodeIds;
    setRunScope(ids);
    if (planApproved && !dirty && !planStale && !planningSettingsStale && activeRuntimeCanExecute && !isPaused) await startOrContinue(ids);
    else { setBottomTab('plan'); if (!activePlan || planStale || dirty) await requestPlan(); }
  };
  const cancelRun = async () => {
    if (!activeExecution) return;
    try { const next = await api.cancelExecution(activeExecution.id); setActiveExecution(next); setExecutions((value) => value.map((item) => item.id === next.id ? next : item)); setBottomTab('execution'); }
    catch (cause) { setError(messageFrom(cause)); }
  };
  const resetLayout = () => { setPanels({ left: false, right: false, bottom: true }); setLayoutResetKey((value) => value + 1); setEditorView('graph'); };
  const nodeActions = <>
    <button type="button" className="quiet-button" disabled={!selectedNode && !selectedProposalNode} onClick={() => setEditorView('node')}>Configure</button>
    {(['discuss', 'refine', 'fact-check', 'develop'] as const).map((action) => <button type="button" className="quiet-button" key={action} disabled={!chatNodeIds.length || uiBusy} onClick={() => void beginChat(action)}>{action === 'fact-check' ? 'Fact-check' : action[0].toUpperCase() + action.slice(1)}</button>)}
    <button type="button" className="quiet-button" disabled={!chatNodeIds.length || !canEdit || uiBusy} onClick={() => void runSelection()}><IconPlayerPlay size={13} />Run</button>
    <button type="button" className="quiet-button" onClick={() => setBottomTab('trace')}>Inspect</button>
  </>;
  const problems: {label: string; run: () => void}[] = [];
  if (graph && !graph.workspacePath) problems.push({ label: 'Select a project folder before workspace execution.', run: () => setEditorView('settings') });
  if (!provider || !isProviderReady(provider)) problems.push({ label: 'Connect an AI provider to start a conversation.', run: () => setEditorView('settings') });
  if (planStale || planningSettingsStale) problems.push({ label: 'The current plan is stale. Generate and review a new plan.', run: () => setBottomTab('plan') });
  graph?.nodes.filter((node) => !node.title.trim() || !node.objective.trim()).forEach((node) => problems.push({ label: `${node.title || 'Untitled node'} needs a name and objective.`, run: () => { selectIntent(node.id); setEditorView('node'); } }));
  if (error) problems.push({ label: error, run: () => setBottomTab('execution') });
  const commands: WorkbenchCommand[] = [
    { id: 'graph', label: 'View: Graph', run: () => setEditorView('graph') },
    { id: 'node', label: 'Node: Configure selection', disabled: !selectedNode && !selectedProposalNode, run: () => setEditorView('node') },
    ...(['discuss', 'refine', 'fact-check', 'develop'] as const).map((action) => ({ id: action, label: `AI: ${action}`, detail: `${chatNodeIds.length} selected nodes`, run: () => void beginChat(action) })),
    { id: 'relations', label: 'Graph: Connect many-to-many', run: () => setEditorView('relations') },
    { id: 'save', label: 'Graph: Save draft', shortcut: '⌘S', disabled: !dirty || !canEdit, run: () => void saveDraft() },
    { id: 'undo', label: 'Graph: Undo', disabled: !canEdit || !undoStack.current.length, run: () => undoGraph() },
    { id: 'redo', label: 'Graph: Redo', disabled: !canEdit || !redoStack.current.length, run: () => undoGraph(true) },
    { id: 'run', label: 'Execution: Run selection', disabled: !graph || uiBusy, run: () => void runSelection() },
    { id: 'pause', label: 'Execution: Pause after current node', disabled: activeExecution?.status !== 'running', run: () => void pauseExecution() },
    { id: 'trace', label: 'View: Traces', run: () => setBottomTab('trace') },
    { id: 'terminal', label: 'View: Terminal', run: () => setBottomTab('terminal') },
    ...(['agents', 'skills', 'prompts', 'harness', 'settings'] as const).map((view) => ({ id: view, label: `Configure: ${view}`, run: () => setEditorView(view) })),
    { id: 'engineering-settings', label: 'Configure: Skills & engineering settings', detail: 'Harness, Caveman, memory, and context', run: () => openEngineeringSettings() },
    { id: 'design-system', label: 'Design system from this idea', detail: 'Refine scope, architecture, and delivery with the engineering harness', run: () => void beginChat('develop', chatNodeIds, 'Design a coherent system from this idea and connected context. Propose editable nodes appropriate to our delivery scope. Explain stack choices, tradeoffs, assumptions, and unresolved decisions. Include implementation, verification, documentation, environments, and agent/skill guidance where useful.'), disabled: !graph || uiBusy },
    { id: 'layout', label: 'View: Restore layout', run: resetLayout },
    { id: 'focus', label: 'View: Focus graph', run: () => { setPanels({ left: true, right: true, bottom: true }); setEditorView('graph'); } },
    ...(graph?.nodes.map((node) => ({ id: `node-${node.id}`, label: node.title, detail: node.objective, run: () => { selectIntent(node.id); setEditorView('node'); } })) ?? []),
  ];
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'k' || (event.shiftKey && event.key.toLowerCase() === 'p')) { event.preventDefault(); setCommandOpen((value) => !value); }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); if (dirty && canEdit) void saveDraft(); }
      const editing = event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable || Boolean(event.target.closest('.monaco-editor')));
      if (event.key.toLowerCase() === 'z' && !editing) { event.preventDefault(); undoGraph(event.shiftKey); }
      if (event.key.toLowerCase() === 'b') { event.preventDefault(); setPanels((value) => ({ ...value, left: !value.left })); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [graph, dirty, canEdit, historyVersion]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);

  const primaryAction = getPrimaryAction({
    graph,
    plan: activePlan,
    execution: activeExecution,
    dirty,
    isReplanned,
    planStale,
    planningSettingsStale,
    providerCanExecute: activeRuntimeCanExecute,
  });

  return (
    <Theme appearance="dark" accentColor="cyan" grayColor="gray" radius="small" scaling="90%" panelBackground="solid">
      <div className={`workbench-shell${error ? ' has-error' : ''}`}>
        <header className="topbar">
          <Flex align="center" gap="3" minWidth="0">
            <span className="brand-mark"><IconBrandDatabricks size={19} /></span>
            <div className="brand-copy">
              <Text size="2" weight="bold">Graph Engineering</Text>
              
            </div>
            <Separator orientation="vertical" className="h-6 bg-[#31444a]" />
            {graphs.length > 0 && graph && (
              <WorkspaceControls
                workspaces={graphs}
                activeWorkspace={graph}
                busy={uiBusy}
                creating={busy === 'create'}
                renaming={busy === 'rename-workspace'}
                rebinding={busy === 'rebind-workspace'}
                deleting={busy === 'delete-workspace'}
                deleteBlockedReason={workspaceDeleteBlockedReason}
                rebindBlockedReason={workspaceRebindBlockedReason}
                onSelect={(workspaceId) => { void switchWorkspace(workspaceId); }}
                onCreate={createWorkspace}
                onRename={renameWorkspace}
                onRebind={rebindWorkspace}
                onDelete={deleteWorkspace}
              />
            )}
          </Flex>
          <Flex align="center" gap="2">
            <button type="button" className="command-trigger" onClick={() => setCommandOpen(true)}><IconSearch size={14} /><span>Search commands</span><kbd>⌘ K</kbd></button>
            <button type="button" className="chrome-button" aria-label="Toggle explorer" aria-pressed={!panels.left} title="Toggle Explorer" onClick={() => setPanels((value) => ({ ...value, left: !value.left }))}><IconLayoutSidebarLeftCollapse size={17} /></button>
            <button type="button" className="chrome-button" aria-label="Toggle bottom panel" aria-pressed={!panels.bottom} title="Toggle bottom panel" onClick={() => setPanels((value) => ({ ...value, bottom: !value.bottom }))}><IconLayoutBottombarCollapse size={17} /></button>
            <button type="button" className="chrome-button" aria-label="Toggle chat sidebar" aria-pressed={!panels.right} title="Toggle AI chat" onClick={() => setPanels((value) => ({ ...value, right: !value.right }))}><IconLayoutSidebarRightCollapse size={17} /></button>
            {graph && (
              <Tooltip content={dirty ? 'Draft has unsaved changes' : 'Draft is saved'}>
                <Badge color={dirty ? 'amber' : 'green'} variant="soft">{dirty ? 'Unsaved' : 'Saved'}</Badge>
              </Tooltip>
            )}
            <Button variant="soft" color="gray" disabled={!graph || !dirty || uiBusy || isPaused} onClick={() => void saveDraft()}>
              <IconDeviceFloppy size={15} /> {busy === 'save' ? 'Saving' : 'Save draft'}
            </Button>
            {activeExecution && ['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'].includes(activeExecution.status) && <button type="button" className="quiet-button" disabled={uiBusy || activeExecution.status === 'cancel_requested'} onClick={() => void cancelRun()} title="Cancel this run; partial workspace changes may remain"><IconPlayerStop size={14} />{activeExecution.status === 'cancel_requested' ? 'Cancelling…' : 'Cancel'}</button>}
            {isPaused && !hasApprovedSuccessor && (
              <Tooltip content={replanFailed || isReplanned || dirty || planStale || planningSettingsStale ? 'Resume the admitted pinned plan. Newer draft edits, runtime settings, and pending proposals are not applied to this run.' : 'Resume the admitted pinned plan without creating a successor.'}>
                <Button variant="soft" color="gray" disabled={uiBusy} onClick={() => void resumeOriginalPlan()}>
                  <IconRefresh size={15} /> {busy === 'resume-original' ? 'Resuming original' : 'Resume original plan'}
                </Button>
              </Tooltip>
            )}
            {runScope.length > 0 && (!activeExecution || !['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'].includes(activeExecution.status)) && <button type="button" className="quiet-button" aria-label="Use whole plan" disabled={uiBusy} onClick={() => setRunScope([])}>Whole plan</button>}
            {primaryAction === 'waiting' ? (
              <DesktopActionButton variant="warning" disabled>
                <IconRefresh className="spin-icon" size={16} /> Waiting for checkpoint
              </DesktopActionButton>
            ) : primaryAction === 'ready' ? (
              <DesktopActionButton disabled>
                <IconRoute size={16} /> Plan ready
              </DesktopActionButton>
            ) : primaryAction === 'pause' ? (
              <DesktopActionButton variant="warning" disabled={uiBusy} onClick={() => void pauseExecution()}>
                <IconPlayerPause size={16} /> {busy === 'pause' ? 'Pausing' : 'Pause after current node'}
              </DesktopActionButton>
            ) : primaryAction === 'execute' || primaryAction === 'continue' ? (
              <DesktopActionButton disabled={uiBusy} onClick={() => void startOrContinue()}>
                <IconPlayerPlay size={16} /> {busy === 'execute' ? 'Starting' : primaryAction === 'continue' ? 'Continue successor' : runScope.length ? 'Run selection' : 'Run plan'}
              </DesktopActionButton>
            ) : (
              <DesktopActionButton disabled={!graph || graph.nodes.length === 0 || uiBusy || !provider || !isProviderReady(provider)} onClick={() => void requestPlan()}>
                {isPaused ? <IconArrowsDiff size={16} /> : <IconRoute size={16} />}
                {busy === 'plan'
                  ? 'Planning'
                  : isPaused
                    ? 'Create next plan'
                    : planningSettingsStale
                      ? 'Request updated plan'
                      : 'Request plan'}
              </DesktopActionButton>
            )}
          </Flex>
        </header>

        {error && (
          <Callout.Root color="red" size="1" className="error-callout" role="alert">
            <Callout.Icon><IconAlertCircle size={15} /></Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
            <Button
              size="1"
              variant="ghost"
              color="red"
              className="error-dismiss"
              aria-label="Dismiss"
              title="Dismiss error"
              onClick={() => setError(undefined)}
            >
              <IconX size={14} aria-hidden="true" />
            </Button>
          </Callout.Root>
        )}

        {loading ? (
          <LoadingWorkbench />
        ) : !graph ? (
          <EmptyWorkspace onCreate={createWorkspace} creating={busy === 'create'} />
        ) : (
          <div className="ide-body">
          <ActivityBar view={editorView} onView={setEditorView} chatOpen={!panels.right} onChat={() => setPanels((value) => ({ ...value, right: !value.right }))} onTrace={() => setBottomTab('trace')} onTerminal={() => setBottomTab('terminal')} />
          <ResizableWorkbench hiddenPanels={panels} resetKey={layoutResetKey}>
            <NodeLibrary
              nodes={displayNodes}
              search={nodeSearch} onSearch={setNodeSearch} onOpenNode={(id) => { selectIntent(id); setEditorView('node'); }}
              selectedNodeId={selectedNodeId}
              onSelectNode={(nodeId) => {
                selectIntent(nodeId);
                setSelectedProposalNodeId(undefined);
                setGraphFocusRequest((current) => ({ nodeId, sequence: (current?.sequence ?? 0) + 1 }));
              }}
              onAdd={addNode}
              disabled={!canEdit}
              creating={busy === 'create-node'}
            />
            <div className="editor-workspace">
              <div className="editor-tabs" role="tablist" aria-label="Editors">{(['graph', 'node', 'relations', ...(['agents', 'skills', 'prompts', 'settings', 'harness', 'suggestions'].includes(editorView) ? [editorView] : [])] as EditorView[]).map((view) => <button type="button" role="tab" key={view} aria-selected={editorView === view} onClick={() => setEditorView(view)}>{view === 'node' ? selectedNode?.title ?? selectedProposalNode?.title ?? 'Node' : view.charAt(0).toUpperCase() + view.slice(1)}{view === 'graph' && dirty && <span aria-label="Unsaved changes"> ●</span>}</button>)}<div className="editor-tabs-spacer" /><button type="button" aria-label="Undo graph change" title="Undo graph change" disabled={!canEdit || !undoStack.current.length} onClick={() => undoGraph()}><IconArrowBackUp size={15} /></button><button type="button" aria-label="Redo graph change" title="Redo graph change" disabled={!canEdit || !redoStack.current.length} onClick={() => undoGraph(true)}><IconArrowForwardUp size={15} /></button></div>
              <div className="editor-content" role="tabpanel" aria-label={`${editorView} editor`}>
            <section className="canvas-region" aria-label="Graph editor" hidden={editorView !== 'graph'}>
              <div className="canvas-toolbar">
                <Flex align="center" gap="2">
                  <Text size="1" weight="medium">Graph</Text>
                  <Badge variant="outline" color="gray">{graph.nodes.length} {graph.nodes.length === 1 ? 'node' : 'nodes'}</Badge>
                  <Badge variant="outline" color="gray">{showEdges.length} {showEdges.length === 1 ? 'relation' : 'relations'}</Badge>
                  {activePlan?.proposedGraph && (
                    <Badge color="cyan" variant="soft">{activePlan.proposedGraph.nodes.length} proposed specialists, drag or select</Badge>
                  )}
                  {isPaused && <Badge color="amber">Paused, editing enabled</Badge>}
                  {activeExecution?.status === 'pause_requested' && <Badge color="amber">Pause requested, editor locked</Badge>}
                  {planStale && <Badge color="amber">Replan required</Badge>}
                  {planningSettingsStale && <Badge color="amber">Plan settings changed</Badge>}
                </Flex>
                <Flex align="center" gap="2">
                  <Text size="1" color="gray">Runtime</Text>
                  <Select.Root value={providerId} onValueChange={setProviderId}>
                    <Select.Trigger aria-label="Agent runtime" variant="soft" placeholder="Connect runtime" />
                    <Select.Content>
                      {runtimeProviders.map((item) => (
                        <Select.Item key={item.id} value={item.id} disabled={!isProviderReady(item)}>
                          {item.name}{!isProviderReady(item) ? ' not connected' : ''}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  {provider && (
                    <>
                      <span className={`provider-dot${isProviderReady(provider) ? ' is-ready' : ''}`} title={provider.detail} />
                      <Text className="provider-detail" size="1" color="gray" title={provider.detail}>
                        {provider.detail || `${provider.capabilities?.join(', ') || 'Planning'} capability`}
                      </Text>
                    </>
                  )}
                  <div className="research-policy-control">
                    <ResearchPolicyControl
                      providerId={providerId}
                      providerCapabilities={provider?.capabilities}
                      enabled={liveResearchEnabled}
                      onEnabledChange={setLiveResearchEnabled}
                      disabled={uiBusy}
                    />
                  </div>
                </Flex>
              </div>
              <div className="node-action-strip">{nodeActions}<select className="harness-profile-select" aria-label="Delivery scope" value={harnessOptions.profile} disabled={uiBusy} onChange={(event) => setHarnessOptions({ ...harnessOptions, profile: event.target.value as typeof harnessOptions.profile })}><option value="poc">PoC</option><option value="mvp">MVP</option><option value="production">Production</option></select><span className="action-strip-spacer" /><button type="button" className="quiet-button" onClick={() => setEditorView('relations')}>Connect N:M</button><button type="button" className="quiet-button" aria-pressed={showMinimap} onClick={() => setShowMinimap((value) => !value)} title="Toggle minimap"><IconAdjustments size={14} />Map</button></div>
              {groups.length > 0 && <div className="group-strip">{groups.map((group) => <button type="button" key={group} aria-expanded={!collapsedGroups.includes(group)} onClick={() => setCollapsedGroups((value) => value.includes(group) ? value.filter((item) => item !== group) : [...value, group])}>{collapsedGroups.includes(group) ? '▸' : '▾'} {group} <span>{graph.nodes.filter((node) => node.group === group).length}</span></button>)}</div>}
              <Suspense fallback={<div className="canvas-empty" role="status"><span className="plan-loader" /> Loading graph canvas</div>}>
                <GraphCanvas
                  graphId={graph.id}
                  readOnly={!canEdit} selectedNodeIds={selectedNodeIds} onSelectionChange={setSelectedNodeIds}
                  filterQuery={nodeSearch} collapsedGroups={collapsedGroups} showMinimap={showMinimap}
                  onOpenNode={(id) => { selectIntent(id); setEditorView('node'); }} onSelectEdge={() => setEditorView('relations')}
                  nodes={displayNodes}
                  edges={showEdges}
                  proposedGraph={activePlan?.proposedGraph}
                  proposalStatuses={executionDisplay.proposalStatuses}
                  selectedNodeId={selectedNodeId}
                  selectedProposalNodeId={selectedProposalNodeId}
                  focusNodeRequest={graphFocusRequest}
                  onSelectNode={(nodeId) => {
                    selectIntent(nodeId);
                    if (nodeId) setSelectedProposalNodeId(undefined);
                  }}
                  onSelectProposalNode={(nodeId) => {
                    setSelectedProposalNodeId(nodeId);
                    if (nodeId) setSelectedNodeId(undefined);
                  }}
                  onPositionChange={(nodeId, position) => {
                    if (!canEdit) return;
                    updateGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, position } : node) }));
                  }}
                  onPositionsChange={(positions) => {
                    if (!canEdit || !positions.length) return;
                    const byId = new Map(positions.map((item) => [item.nodeId, item.position]));
                    updateGraph((current) => ({ ...current, nodes: current.nodes.map((node) => byId.has(node.id) ? { ...node, position: byId.get(node.id)! } : node) }));
                  }}
                  onConnectNodes={connectDraftNodes}
                />
              </Suspense>
              {isPaused && (
                <div className="paused-guidance">
                  <IconPlayerPause size={14} />
                  <Text size="1">Paused at a checkpoint in plan v{plans.find((item) => item.id === activeExecution?.planId)?.version ?? '?'}. Resume the original plan, or edit the draft and approve a successor.</Text>
                </div>
              )}
            </section>
            {editorView === 'node' && (selectedProposalNode && activePlan ? (
              <ProposalInspector
                node={selectedProposalNode}
                plan={activePlan}
                nextPlanVersion={nextPlanVersion}
                sourceIntents={selectedProposalSourceIntents}
                evidenceSources={sources}
                proposalNodes={activePlan.proposedGraph?.nodes ?? []}
                readOnly={!canEdit}
                planning={busy === 'plan'}
                onRefine={refineProposalNode}
              />
            ) : (
              <NodeInspector
                node={selectedNode}
                actions={<div className="node-actions">{nodeActions}</div>}
                configuration={selectedNode && <><NodeReferences graph={graph} node={selectedNode} onOpen={(id) => { selectIntent(id); setEditorView('node'); }} /><NodeConfiguration key={selectedNode.id} node={selectedNode} nodes={graph.nodes} agents={agents} providers={providers} readOnly={!canEdit} onChange={updateSelectedNode} /></>}
                sources={selectedNodeSources}
                sourcesLoading={sourcesLoading}
                sourcesError={sourcesError}
                uploadingSources={busy === 'upload' || busy === 'create-node'}
                retrievalHits={retrievalHits}
                retrievalLoading={retrievalLoading}
                retrievalError={retrievalError}
                readOnly={!canEdit}
                onChange={updateSelectedNode}
                onDelete={removeSelectedNode}
                onUploadSources={uploadSelectedNodeSources}
                onSearchSources={searchSources}
              />
            ))}
              {editorView === 'relations' && <RelationsPanel key={graph.id} graph={graph} initialSelection={selectedNodeIds} readOnly={!canEdit} onChange={(edges) => updateGraph((value) => ({ ...value, edges }))} onSuggest={(ids) => void beginChat('refine', ids, 'Suggest useful relationships between these nodes. Explain each connection and whether it affects execution order. Propose edge additions for review.')} />}
              {(['agents', 'skills', 'prompts'] as string[]).includes(editorView) && <CatalogPanel section={editorView as 'agents' | 'skills' | 'prompts'} onChanged={() => void refreshCatalogs()} settingsAction={editorView === 'skills' ? <button type="button" onClick={() => openEngineeringSettings('skills')}>Skills &amp; engineering settings</button> : undefined} />}
              {editorView === 'harness' && <HarnessPanel key={graph.id} graphId={graph.id} options={harnessOptions} onChange={setHarnessOptions} disabled={uiBusy} onDesign={() => void beginChat('develop', chatNodeIds, 'Design a coherent system from this idea and connected context. Propose editable nodes appropriate to our delivery scope. Explain stack choices, tradeoffs, assumptions, and unresolved decisions. Include implementation, verification, documentation, environment setup, and agent/skill guidance where useful.')} />}
              {editorView === 'suggestions' && activePlan && <SuggestionReview key={activePlan.id} graphId={graph.id} revision={graph.draftRevision} plan={activePlan} disabled={!canEdit || dirty || planStale || activePlan.status === 'superseded'} onBusy={setChatDraftLocked} onApplied={async () => { await refreshAppliedGraph(); setActivePlan(undefined); setSelectedProposalNodeId(undefined); setEditorView('graph'); }} />}
              {editorView === 'settings' && <section className="editor-page settings-editor"><header className="editor-page-heading"><div><h1>Settings</h1><p>Connect an AI provider and configure your workspace.</p></div><button type="button" className="quiet-button" onClick={resetLayout}>Restore layout</button></header><ProviderSettings providers={providers} onDiscover={discoverProvider} onConnect={connectProvider} onRefreshModels={refreshProviderModels} onDisconnect={disconnectProvider} /><div className="settings-links"><button type="button" className="quiet-button" onClick={() => openEngineeringSettings('harness')}>Skills &amp; engineering settings</button><button type="button" className="quiet-button" onClick={() => setEditorView('agents')}>Edit agents</button><button type="button" className="quiet-button" onClick={() => setEditorView('skills')}>Edit skills</button><button type="button" className="quiet-button" onClick={() => setEditorView('prompts')}>Edit prompt templates</button></div></section>}
              </div>
            </div>
            <ChatPanel engineeringHarness={harnessOptions} onHarnessSettings={() => setEditorView('harness')} catalogVersion={catalogVersion} contextStale={dirty} canApply={canEdit} graphId={graph.id} graphRevision={graph.draftRevision} providerId={providerId} providers={providers} nodeIds={chatNodeIds} actionRequest={actionRequest} onBeforeSend={async () => { await persistCurrentDraftBeforeLeaving(); }} onApplyingChange={setChatDraftLocked} onApplied={refreshAppliedGraph} />
            <section className="bottom-panel" aria-label="Planning, execution, and trace details">
              <Tabs.Root value={bottomTab} onValueChange={setBottomTab}>
                <Tabs.List>
                  <Tabs.Trigger value="plan"><IconBolt size={14} /> Plan {activePlan && `v${activePlan.version}`}</Tabs.Trigger>
                  <Tabs.Trigger value="execution"><IconPlayerPlay size={14} /> Execution {activeExecution && shortId(activeExecution.id)}</Tabs.Trigger>
                  <Tabs.Trigger value="trace"><IconActivity size={14} /> Traces</Tabs.Trigger>
                  <Tabs.Trigger value="terminal">Terminal</Tabs.Trigger>
                  <Tabs.Trigger value="problems">Problems</Tabs.Trigger>
                  <div className="planning-context-field">
                    <TextField.Root
                      size="1"
                      value={planningContext}
                      onChange={(event) => setPlanningContext(event.target.value)}
                      placeholder={isPaused ? 'Context for the successor plan' : 'Optional planning instructions'}
                      aria-label="Planner instructions"
                    />
                  </div>
                </Tabs.List>
                <Tabs.Content value="plan">
                  <Suspense fallback={<PanelLoading label="Loading plan view" />}>
                    <PlanPanel
                      graph={graph}
                      plan={activePlan}
                      previousPlan={previousPlan}
                      loading={busy === 'plan'}
                      approvalContext={approvalContext}
                      onApprovalContextChange={setApprovalContext}
                      onApprove={() => void approvePlan()}
                      approving={busy === 'approve'}
                      onReviewSuggestions={() => setEditorView('suggestions')}
                      canReviewSuggestions={canEdit && !dirty && !planStale && activePlan?.status !== 'superseded'}
                    />
                  </Suspense>
                </Tabs.Content>
                <Tabs.Content value="execution">
                  <Suspense fallback={<PanelLoading label="Loading execution view" />}>
                    <ExecutionPanel
                      graph={graph}
                      plan={plans.find((plan) => plan.id === activeExecution?.planId) ?? activePlan}
                      execution={activeExecution}
                      executions={executions}
                      events={events}
                      artifacts={artifacts}
                      connected={streamConnected}
                    />
                  </Suspense>
                </Tabs.Content>
                <Tabs.Content value="terminal"><TerminalPanel graphId={graph.id} workspacePath={graph.workspacePath} disabledReason={workspaceRebindBlockedReason} /></Tabs.Content>
                <Tabs.Content value="problems"><div className="problems-list" aria-label="Workspace problems">{problems.length ? problems.map((problem, index) => <button type="button" key={index} onClick={problem.run}><IconAlertCircle size={14} />{problem.label}</button>) : <p>No problems detected in the current draft.</p>}</div></Tabs.Content>
                <Tabs.Content value="trace">
                  <Suspense fallback={<PanelLoading label="Loading trace explorer" />}>
                    <TracePanel
                      graph={graph}
                      plan={activePlan}
                      execution={activeExecution}
                      selectedNodeId={selectedNodeId}
                      selectedProposalNodeId={selectedProposalNodeId}
                      liveEvents={traceEvents}
                      connected={traceStreamConnected}
                    />
                  </Suspense>
                </Tabs.Content>
              </Tabs.Root>
            </section>
          </ResizableWorkbench>
          </div>
        )}
        <footer className="statusbar"><span title={graph?.workspacePath}>{graph?.workspacePath ?? 'No project folder selected'}</span><button type="button" onClick={() => setEditorView('settings')}>{provider?.name ?? 'Connect AI'}{provider?.profile?.model ? ` · ${provider.profile.model}` : ''}</button><span>{activeExecution?.status.replaceAll('_', ' ') ?? 'Ready'}</span><button type="button" onClick={() => setBottomTab('problems')}>{problems.length} problems</button><span>{graph ? `Draft ${graph.draftRevision ?? 0}${dirty ? ' · unsaved' : ''}` : 'Local workspace'}</span></footer>
        <EngineeringSettingsDialog open={engineeringSettingsOpen} initialTab={engineeringSettingsTab} onOpenChange={setEngineeringSettingsOpen} onSaved={() => void refreshCatalogs()} />
        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} commands={commands} />
      </div>
    </Theme>
  );
}

function EmptyWorkspace({ onCreate, creating }: { onCreate: (name: string) => Promise<void>; creating: boolean }) {
  return (
    <main className="empty-workspace">
      <span className="empty-workspace-icon"><IconBrandDatabricks size={34} /></span>
      <Heading as="h1" size="7" weight="bold">Create a workspace</Heading>
      <Text as="p" size="2" color="gray">A workspace contains only the context nodes you add.</Text>
      <CreateWorkspaceDialog onCreate={onCreate} creating={creating} />
    </main>
  );
}

function LoadingWorkbench() {
  return <main className="loading-workspace" role="status"><span className="plan-loader" /><Text size="2">Loading local workspaces</Text></main>;
}

function PanelLoading({ label }: { label: string }) {
  return <div className="bottom-empty" role="status"><span className="plan-loader" />{label}</div>;
}

function getPrimaryAction({ graph, plan, execution, dirty, isReplanned, planStale, planningSettingsStale, providerCanExecute }: {
  graph?: EngineeringGraph;
  plan?: PlanVersion;
  execution?: ExecutionRun;
  dirty: boolean;
  isReplanned: boolean;
  planStale: boolean;
  planningSettingsStale: boolean;
  providerCanExecute: boolean;
}): 'plan' | 'execute' | 'pause' | 'continue' | 'waiting' | 'ready' {
  if (execution?.status === 'running' || execution?.status === 'queued') return 'pause';
  if (execution?.status === 'pause_requested') return 'waiting';
  if (execution?.status === 'paused') {
    if (isReplanned && plan?.status === 'approved' && !dirty && !planStale && !planningSettingsStale) return 'continue';
    return 'plan';
  }
  if (graph && plan?.status === 'approved' && !dirty && !planStale && !planningSettingsStale) {
    return providerCanExecute ? 'execute' : 'ready';
  }
  return 'plan';
}

function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 8) : value;
}

function isProviderReady(provider: ProviderStatus): boolean {
  return provider.available
    && provider.connection?.status === 'CONNECTED'
    && provider.connection.verified
    && (provider.capabilities?.includes('plan') ?? false);
}

function isUserRuntimeProvider(provider: ProviderStatus): boolean {
  return provider.id !== 'local-agents' && provider.id !== 'simulation';
}

function retainedNodeSelection(current: string | undefined, graph: EngineeringGraph): string | undefined {
  return current && graph.nodes.some((node) => node.id === current) ? current : graph.nodes[0]?.id;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The local service returned an unexpected error.';
}

function appendProposalRefinement(context: string, planVersion: number, proposalTitle: string, request: string): string {
  const entry = `[Proposal refinement from Plan v${planVersion}: ${proposalTitle}]\n${request}`;
  const current = context.trimEnd();
  if (current.includes(entry)) return context;
  return `${current}${current ? '\n\n' : ''}${entry}`;
}

async function uploadSourceFiles(graphId: string, nodeId: string, files: File[]): Promise<{ items: SourceRecord[]; errors: string[] }> {
  const results = await Promise.allSettled(files.map((file) => api.uploadSource(graphId, nodeId, file)));
  return results.reduce<{ items: SourceRecord[]; errors: string[] }>((output, result, index) => {
    if (result.status === 'fulfilled') output.items.push(result.value);
    else output.errors.push(`${files[index].name}: ${messageFrom(result.reason)}`);
    return output;
  }, { items: [], errors: [] });
}

function readPreference<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(`ege.ide.${key}`);
    if (!saved) return fallback;
    const value: unknown = JSON.parse(saved);
    if (typeof fallback === 'object' && fallback !== null) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
      return Object.fromEntries(Object.entries(fallback).map(([name, initial]) => {
        const candidate = (value as Record<string, unknown>)[name];
        return [name, typeof candidate === typeof initial ? candidate : initial];
      })) as T;
    }
    return typeof value === typeof fallback ? value as T : fallback;
  } catch { return fallback; }
}
function storePreference(key: string, value: unknown) { try { localStorage.setItem(`ege.ide.${key}`, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ } }
