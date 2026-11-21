// Jira admin page "Canon setup": setup checklist, gate settings, sample data.
// Resolvers are admin-only; NOT_ADMIN and other failures are shown inline.
import { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  DynamicTable,
  Heading,
  Inline,
  Label,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Text,
  Textfield,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import type { SetupCheck } from '../domain/setupChecks';
import type { SampleState, Settings } from '../domain/types';

type Failure = { ok: false; error: string; message: string };
type Res<T> = ({ ok: true } & T) | Failure;
type Loaded = { status: 'LOADED' | 'ALREADY_LOADED'; state: SampleState };
type Published = { status: 'PUBLISHED' | 'ALREADY_PUBLISHED'; version: number };

const GENERIC = 'Canon could not complete this request. Try again.';
const VALIDATOR_MODES = ['block', 'warn'] as const;
const REVISION_POLICIES = ['approved-only', 'every-major'] as const;
const VALIDATOR_OPTIONS = [
  { label: 'Block', value: 'block' },
  { label: 'Warn', value: 'warn' },
];
const POLICY_OPTIONS = [
  { label: 'Approved only', value: 'approved-only' },
  { label: 'Every major edit', value: 'every-major' },
];
const STATUS: Record<SetupCheck['status'], { appearance: 'success' | 'moved' | 'removed'; text: string }> = {
  ok: { appearance: 'success', text: 'OK' },
  warn: { appearance: 'moved', text: 'CHECK' },
  fail: { appearance: 'removed', text: 'FIX' },
};

// invoke() may wrap results in {body, metadata}; resolvers return the payload directly
// unless they attach metadata, so unwrap `body` only when that wrapper is present.
async function call<T>(name: string, payload: object): Promise<Res<T>> {
  const res: unknown = await invoke(name, payload);
  if (typeof res === 'object' && res !== null && 'body' in res && !('ok' in res)) {
    return (res as { body: Res<T> }).body;
  }
  return res as Res<T>;
}

// Runs a resolver call. Resolves to the payload on success; on failure or throw, sets the
// message and resolves to null (fail closed: nothing is assumed to have happened).
async function attempt<T extends object>(
  name: string,
  payload: object,
  setError: (message: string) => void,
): Promise<({ ok: true } & T) | null> {
  try {
    const res = await call<T>(name, payload);
    if (res.ok) return res;
    setError(res.message);
  } catch {
    setError(GENERIC);
  }
  return null;
}

// Select passes the chosen { label, value } option to onChange; keep only known values.
function pick<V extends string>(option: unknown, allowed: readonly V[]): V | null {
  const v = typeof option === 'object' && option !== null && 'value' in option ? (option as { value: unknown }).value : null;
  return allowed.find((a) => a === v) ?? null;
}

const Title = ({ children }: { children: string }) => (
  <Text>
    <Strong>{children}</Strong>
  </Text>
);

const Messages = ({ error, notice }: { error: string | null; notice: string | null }) => (
  <>
    {error && (
      <SectionMessage appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    )}
    {notice && (
      <SectionMessage appearance="success">
        <Text>{notice}</Text>
      </SectionMessage>
    )}
  </>
);

const ChecklistSection = ({ tick, onRerun }: { tick: number; onRerun: () => void }) => {
  const [checks, setChecks] = useState<SetupCheck[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void attempt<{ checks: SetupCheck[] }>('canonSetupChecks', {}, setError).then((r) => {
      if (r) setChecks(r.checks);
      setLoading(false);
    });
  }, [tick]);

  return (
    <Stack space="space.100">
      <Title>Setup checklist</Title>
      <Inline space="space.100" alignBlock="center">
        <Button isDisabled={loading} onClick={onRerun}>
          Re-run checks
        </Button>
        {loading && <Spinner size="medium" />}
      </Inline>
      <Messages error={error} notice={null} />
      {checks.map((c) => (
        <Stack key={c.id} space="space.050">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={STATUS[c.status].appearance}>{STATUS[c.status].text}</Lozenge>
            <Strong>{c.title}</Strong>
          </Inline>
          <Text>{c.detail}</Text>
          {c.fix && <Text>{`How to fix: ${c.fix}`}</Text>}
        </Stack>
      ))}
    </Stack>
  );
};

const SettingsSection = ({ onSaved }: { onSaved: () => void }) => {
  const [form, setForm] = useState<Settings | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newPage, setNewPage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void attempt<{ settings: Settings }>('canonSettings', {}, setError).then((r) => {
      if (r) setForm(r.settings);
    });
  }, []);

  const addMapping = () => {
    const key = newKey.trim();
    const page = newPage.trim();
    if (!key || !page) {
      setError('Enter both a project/issue type and a Confluence page id to add a mapping.');
      return;
    }
    setError(null);
    setForm((f) => f && { ...f, autoBind: { ...f.autoBind, [key]: page } });
    setNewKey('');
    setNewPage('');
  };

  const removeMapping = (key: string) =>
    setForm((f) => f && { ...f, autoBind: Object.fromEntries(Object.entries(f.autoBind).filter(([k]) => k !== key)) });

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const r = await attempt<{ settings: Settings }>(
      'canonSaveSettings',
      { validatorMode: form.validatorMode, revisionPolicy: form.revisionPolicy, autoBind: form.autoBind },
      setError,
    );
    if (r) {
      setForm(r.settings);
      setNotice('Settings saved.');
      onSaved();
    }
    setSaving(false);
  };

  return (
    <Stack space="space.100">
      <Title>Gate settings</Title>
      <Messages error={error} notice={notice} />
      {!form && !error && <Spinner size="medium" />}
      {form && (
        <>
          <Inline space="space.200" alignBlock="end">
            <Stack space="space.050">
              <Label labelFor="canon-validator-mode">Validator mode</Label>
              <Select
                inputId="canon-validator-mode"
                options={VALIDATOR_OPTIONS}
                value={VALIDATOR_OPTIONS.find((o) => o.value === form.validatorMode)}
                onChange={(o: unknown) => {
                  const v = pick(o, VALIDATOR_MODES);
                  if (v) setForm((f) => f && { ...f, validatorMode: v });
                }}
              />
            </Stack>
            <Stack space="space.050">
              <Label labelFor="canon-revision-policy">Revision policy</Label>
              <Select
                inputId="canon-revision-policy"
                options={POLICY_OPTIONS}
                value={POLICY_OPTIONS.find((o) => o.value === form.revisionPolicy)}
                onChange={(o: unknown) => {
                  const v = pick(o, REVISION_POLICIES);
                  if (v) setForm((f) => f && { ...f, revisionPolicy: v });
                }}
              />
            </Stack>
          </Inline>
          <Title>Auto-bind mappings</Title>
          <DynamicTable
            head={{
              cells: [
                { key: 'key', content: 'Project/Issue type' },
                { key: 'page', content: 'Page id' },
                { key: 'remove', content: '' },
              ],
            }}
            rows={Object.entries(form.autoBind).map(([k, v]) => ({
              key: k,
              cells: [
                { key: 'key', content: k },
                { key: 'page', content: v },
                { key: 'remove', content: <Button onClick={() => removeMapping(k)}>Remove</Button> },
              ],
            }))}
            emptyView={<Text>No auto-bind mappings yet</Text>}
          />
          <Inline space="space.100" alignBlock="end">
            <Textfield
              name="canon-automap-key"
              placeholder="Project/Issue type, e.g. CHG/Task"
              value={newKey}
              onChange={(e) => setNewKey(String(e.target.value ?? ''))}
            />
            <Textfield
              name="canon-automap-page"
              placeholder="Confluence page id"
              value={newPage}
              onChange={(e) => setNewPage(String(e.target.value ?? ''))}
            />
            <Button isDisabled={saving} onClick={addMapping}>
              Add mapping
            </Button>
          </Inline>
          <Inline space="space.100" alignBlock="center">
            <Button appearance="primary" isDisabled={saving} onClick={() => void save()}>
              Save settings
            </Button>
            {saving && <Spinner size="medium" />}
          </Inline>
        </>
      )}
    </Stack>
  );
};

const SampleSection = ({ onChanged }: { onChanged: () => void }) => {
  // undefined = still loading; null = nothing loaded yet.
  const [sample, setSample] = useState<SampleState | null | undefined>(undefined);
  const [spaceKey, setSpaceKey] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchSample = useCallback(async () => {
    const r = await attempt<{ sample: SampleState | null }>('canonSampleState', {}, setError);
    setSample(r?.sample ?? null);
  }, []);

  useEffect(() => {
    void fetchSample();
  }, [fetchSample]);

  const loadSample = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await attempt<{ result: Loaded }>('canonLoadSample', { spaceKey, projectKey }, setError);
    if (r) {
      const { status, state } = r.result;
      const i = state.issues;
      setSample(state);
      setNotice(
        status === 'ALREADY_LOADED'
          ? 'Already loaded'
          : `Loaded: page ${state.pageId}, issues ${i.done}, ${i.hero}, ${i.second}, ${i.todo}`,
      );
      onChanged();
    }
    setBusy(false);
  };

  const publishV4 = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await attempt<{ result: Published }>('canonPublishV4', {}, setError);
    if (r) {
      setNotice(
        r.result.status === 'PUBLISHED'
          ? "Published v4 as the Canon app. Open the page and click Approve v4 in the Canon byline (an editor can't approve their own edit)."
          : 'v4 already published',
      );
      await fetchSample();
      onChanged();
    }
    setBusy(false);
  };

  return (
    <Stack space="space.100">
      <Title>Sample data</Title>
      <Messages error={error} notice={notice} />
      {(busy || sample === undefined) && <Spinner size="medium" />}
      {sample === null && (
        <>
          <Text>
            Use a Confluence space that Canon can read (a space created after install, or add Canon under Space settings →
            Users). Creates SOP-PAY-014 [Sample data] v1–v3 and 4 [Sample] work items.
          </Text>
          <Inline space="space.100" alignBlock="end">
            <Textfield
              name="canon-sample-space"
              placeholder="Confluence space key"
              value={spaceKey}
              onChange={(e) => setSpaceKey(String(e.target.value ?? '').toUpperCase())}
            />
            <Textfield
              name="canon-sample-project"
              placeholder="Jira project key"
              value={projectKey}
              onChange={(e) => setProjectKey(String(e.target.value ?? '').toUpperCase())}
            />
            <Button appearance="primary" isDisabled={busy} onClick={() => void loadSample()}>
              Load sample data
            </Button>
          </Inline>
        </>
      )}
      {sample && (
        <>
          <Text>{`Space ${sample.spaceKey} · project ${sample.projectKey} · page ${sample.pageId}`}</Text>
          <Text>{`Issues: ${sample.issues.done}, ${sample.issues.hero}, ${sample.issues.second}, ${sample.issues.todo}`}</Text>
          <Text>{`Loaded at ${sample.loadedAt}`}</Text>
          {sample.v4PublishedAt && <Text>{`v4 published at ${sample.v4PublishedAt}`}</Text>}
          <Inline space="space.100" alignBlock="center">
            <Button appearance="primary" isDisabled={busy} onClick={() => void publishV4()}>
              Publish sample v4
            </Button>
          </Inline>
        </>
      )}
    </Stack>
  );
};

const App = () => {
  const [tick, setTick] = useState(0);
  const rerun = useCallback(() => setTick((t) => t + 1), []);

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading as="h2">Canon setup</Heading>
        <Text>Canon blocks Jira Done when the bound Confluence procedure gets a newer approved version.</Text>
      </Stack>
      <ChecklistSection tick={tick} onRerun={rerun} />
      <SettingsSection onSaved={rerun} />
      <SampleSection onChanged={rerun} />
    </Stack>
  );
};

ForgeReconciler.render(<App />);
