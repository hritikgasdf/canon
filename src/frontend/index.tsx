// Jira issue panel for Canon.
// Tabs: "Status" today; later items add Delta, Attest, Evidence as new
// Tab + TabPanel pairs, each rendered by its own component below.
// Below the tabs, a "Bind procedure" section lets the user search for and
// bind a controlled procedure to this issue.
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import { RESTRICTED_LABEL } from '../domain/issueView';
import type { IssueBindingView, IssueView } from '../domain/issueView';
import type { BindingDeltaView } from '../domain/issueDelta';
import type { BindingState, DeltaItem, DeltaKind } from '../domain/types';

// ---- Typed backend response shapes (mirror src/forge/resolvers.ts) ----

type Failure = { ok: false; error: string; message: string };

type ViewResponse = { ok: true; view: IssueView } | Failure;

type DeltaResponse = { ok: true; delta: BindingDeltaView } | Failure;

type ProcedureSummary = { pageId: string; title: string; currentApproved: number };

type ListResponse = { ok: true; procedures: ProcedureSummary[] } | Failure;

type BindResponse = { ok: true; binding: unknown } | Failure;

// ---- Load state for the issue view ----

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; view: IssueView };

// ---- Helpers ----

const LOZENGE_FOR_STATE: Record<BindingState, { text: string; appearance: 'success' | 'removed' | 'inprogress' | 'moved' }> = {
  CURRENT: { text: 'CURRENT', appearance: 'success' },
  SUPERSEDED: { text: 'SUPERSEDED', appearance: 'removed' },
  REATTESTING: { text: 'REATTESTING', appearance: 'inprogress' },
  CLEARED: { text: 'CLEARED', appearance: 'success' },
  ORPHANED: { text: 'ORPHANED', appearance: 'moved' },
};

const LOZENGE_FOR_KIND: Record<DeltaKind, { appearance: 'new' | 'inprogress' | 'removed' | 'default' }> = {
  ADDED: { appearance: 'new' },
  CHANGED: { appearance: 'inprogress' },
  REMOVED: { appearance: 'removed' },
  MOVED: { appearance: 'default' },
};

/** Extracts the selected option's value from a Forge Select change event. */
function selectedValue(option: unknown): string | null {
  if (typeof option === 'object' && option !== null && !Array.isArray(option) && 'value' in option) {
    const value = (option as { value: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

// ---- Status tab ----

const BindingStatusRow = ({ binding }: { binding: IssueBindingView }) => {
  const title = binding.restricted ? RESTRICTED_LABEL : binding.title ?? binding.pageId;
  const approved =
    !binding.restricted && typeof binding.currentApproved === 'number'
      ? ` · approved v${binding.currentApproved}`
      : '';
  const lozenge = LOZENGE_FOR_STATE[binding.state];
  return (
    <Stack space="space.050">
      <Text>{title}</Text>
      <Inline space="space.100" alignBlock="center">
        <Text>{`Bound to v${binding.boundVersion}${approved}`}</Text>
        <Lozenge appearance={lozenge.appearance}>{lozenge.text}</Lozenge>
      </Inline>
    </Stack>
  );
};

const StatusTab = ({ view }: { view: IssueView }) => {
  if (view.bindings.length === 0) {
    return <Text>No controlled procedure bound.</Text>;
  }
  return (
    <Stack space="space.200">
      {view.bindings.map((b) => (
        <BindingStatusRow key={b.id} binding={b} />
      ))}
    </Stack>
  );
};

// ---- Delta tab ----

type DeltaLoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; delta: BindingDeltaView };

const DeltaItemRow = ({ item }: { item: DeltaItem }) => (
  <Stack space="space.050">
    <Inline space="space.100" alignBlock="center">
      <Lozenge appearance={LOZENGE_FOR_KIND[item.kind].appearance}>{item.kind}</Lozenge>
      <Text>{item.path.join(' › ')}</Text>
      {item.trivial && <Lozenge>trivial</Lozenge>}
    </Inline>
    {item.before !== null && <Text>{`Before: ${item.before}`}</Text>}
    {item.after !== null && <Text>{`After: ${item.after}`}</Text>}
    {item.hints.length > 0 && (
      <Inline space="space.050">
        {item.hints.map((hint) => (
          <Lozenge key={hint}>{hint}</Lozenge>
        ))}
      </Inline>
    )}
  </Stack>
);

const BindingDelta = ({ bindingId }: { bindingId: string }) => {
  const [state, setState] = useState<DeltaLoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = (await invoke('canonBindingDelta', { bindingId })) as DeltaResponse;
        if (cancelled) return;
        setState(res.ok ? { kind: 'ready', delta: res.delta } : { kind: 'error', message: res.message });
      } catch (e) {
        if (cancelled) return;
        setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load delta.' });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [bindingId]);

  if (state.kind === 'loading') return <Spinner />;
  if (state.kind === 'error') {
    return (
      <SectionMessage appearance="error">
        <Text>{state.message}</Text>
      </SectionMessage>
    );
  }

  const { delta } = state;
  if (delta.status === 'PROCEDURE_MISSING') {
    return (
      <SectionMessage appearance="warning">
        <Text>Canon has no record of this procedure.</Text>
      </SectionMessage>
    );
  }
  // No newer approved version, or nothing changed in it: nothing to show for this binding.
  if (delta.status === 'NO_CHANGES' || delta.toVersion === null) return <Text>No procedure changes since binding.</Text>;

  return (
    <Stack space="space.100">
      <Heading as="h4">{`${delta.title || delta.pageId}: v${delta.fromVersion} → v${delta.toVersion}`}</Heading>
      <Text>{`${delta.materialCount} material changes (${delta.items.length} items in total, trivial ones marked)`}</Text>
      {delta.items.map((item, index) => (
        <DeltaItemRow key={`${item.kind}:${item.path.join('/')}:${index}`} item={item} />
      ))}
    </Stack>
  );
};

const DeltaTab = ({ view }: { view: IssueView }) => {
  // Every visible binding is asked: the server decides CHANGES / NO_CHANGES / PROCEDURE_MISSING.
  // Restricted bindings are skipped; the server would refuse them anyway.
  const visible = view.bindings.filter((b) => !b.restricted);
  if (visible.length === 0) {
    return <Text>No procedure changes since binding.</Text>;
  }
  return (
    <Stack space="space.300">
      {visible.map((b) => (
        <BindingDelta key={b.id} bindingId={b.id} />
      ))}
    </Stack>
  );
};

// ---- Bind section (below the tabs) ----

type BindSectionProps = { onBound: () => Promise<void> };

const BindSection = ({ onBound }: BindSectionProps) => {
  const [query, setQuery] = useState('');
  const [procedures, setProcedures] = useState<ProcedureSummary[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setError(null);
    try {
      const res = (await invoke('canonListProcedures', { query })) as ListResponse;
      if (res.ok) {
        setProcedures(res.procedures);
        setSelectedPageId(null);
      } else {
        setError(res.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed.');
    }
  };

  const bind = async () => {
    if (!selectedPageId) return;
    setError(null);
    try {
      const res = (await invoke('canonBind', { pageId: selectedPageId })) as BindResponse;
      if (res.ok) {
        await onBound();
      } else {
        setError(res.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bind failed.');
    }
  };

  return (
    <Stack space="space.200">
      <Heading as="h4">Bind procedure</Heading>
      {error !== null && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      <Inline space="space.100" alignBlock="end">
        <Textfield
          name="procedure-query"
          placeholder="Search procedures by title"
          onChange={(e) => setQuery(String(e.target.value ?? ""))}
        />
        <Button onClick={search}>Search</Button>
      </Inline>
      {procedures.length > 0 && (
        <Select
          inputId="canon-procedure"
          placeholder="Choose a procedure"
          options={procedures.map((p) => ({ label: `${p.title} (v${p.currentApproved})`, value: p.pageId }))}
          onChange={(option: unknown) => setSelectedPageId(selectedValue(option))}
        />
      )}
      <Button appearance="primary" isDisabled={selectedPageId === null} onClick={bind}>
        Bind current approved version
      </Button>
    </Stack>
  );
};

// ---- App ----

const App = () => {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  const loadView = useCallback(async (): Promise<void> => {
    try {
      const res = (await invoke('canonIssueView')) as ViewResponse;
      setState(res.ok ? { kind: 'ready', view: res.view } : { kind: 'error', message: res.message });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load Canon status.' });
    }
  }, []);

  useEffect(() => {
    void loadView();
  }, [loadView]);

  return (
    <Stack space="space.300">
      <Heading as="h3">Canon</Heading>
      {state.kind === 'error' && (
        <SectionMessage appearance="error">
          <Text>{state.message}</Text>
        </SectionMessage>
      )}
      {state.kind === 'loading' && <Text>Loading...</Text>}
      {state.kind === 'ready' && (
        <Tabs id="canon-tabs">
          <TabList>
            <Tab>Status</Tab>
            <Tab>Delta</Tab>
          </TabList>
          <TabPanel>
            <StatusTab view={state.view} />
          </TabPanel>
          <TabPanel>
            <DeltaTab view={state.view} />
          </TabPanel>
        </Tabs>
      )}
      <BindSection onBound={loadView} />
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
