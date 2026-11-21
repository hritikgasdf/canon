// Jira project page "Canon register": every work item bound to a Confluence procedure in this project.
// Resolvers are project-scoped and permission-aware; restricted rows arrive without procedure details.
import { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  Textfield,
  xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import type { ChainCheck, Register, RegisterRow, RegisterStatus } from '../domain/register';

type Failure = { ok: false; error: string; message: string };
type Res<T> = ({ ok: true } & T) | Failure;
type Verification = { results: ChainCheck[]; allOk: boolean; checked: number };
type Option = { label: string; value: string };

const GENERIC = 'Canon could not complete this request. Try again.';
const RESTRICTED_TITLE = 'Procedure restricted'; // Hardcoded: RESTRICTED_LABEL lives in a module the UI bundle cannot import.
const ALL = 'ALL';
const filterBox = xcss({ width: '240px' });
const STATUSES: RegisterStatus[] = ['SUPERSEDED', 'REATTESTING', 'ORPHANED', 'CURRENT', 'CLEARED', 'CLOSED'];
const LOZENGE: Record<RegisterStatus, 'removed' | 'moved' | 'success' | 'default'> = {
  SUPERSEDED: 'removed',
  REATTESTING: 'moved',
  ORPHANED: 'removed',
  CURRENT: 'success',
  CLEARED: 'success',
  CLOSED: 'default',
};
const STATUS_OPTIONS: Option[] = [{ label: 'All', value: ALL }, ...STATUSES.map((s) => ({ label: s, value: s }))];

// invoke() may wrap results in {body, metadata}; unwrap only when that wrapper is present.
async function call<T>(name: string, payload: object): Promise<Res<T>> {
  const res: unknown = await invoke(name, payload);
  if (typeof res === 'object' && res !== null && 'body' in res && !('ok' in res)) {
    return (res as { body: Res<T> }).body;
  }
  return res as Res<T>;
}

// Resolves to the payload on success; on failure or throw, sets the message and resolves to null.
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

// Select passes the chosen { label, value } option to onChange.
function pickValue(option: unknown): string {
  return typeof option === 'object' && option !== null && 'value' in option
    ? String((option as { value: unknown }).value)
    : ALL;
}

const procedureLabel = (row: RegisterRow) => (row.restricted ? RESTRICTED_TITLE : (row.title ?? '—'));
// Procedure filter key: the page id for visible procedures, one shared key for restricted rows.
const procedureKey = (row: RegisterRow) => (row.restricted ? RESTRICTED_TITLE : row.pageId);

const bindingText = (r: RegisterRow) =>
  `${r.restricted ? 'Procedure restricted' : (r.title ?? '—')} v${r.boundVersion ?? '?'}→v${r.currentApproved ?? '?'} ${r.status}`;
// STATUSES is ordered most urgent first.
const mostUrgent = (rows: RegisterRow[]): RegisterStatus =>
  STATUSES.find((s) => rows.some((r) => r.status === s)) ?? 'CLOSED';

const RegisterView = ({ register }: { register: Register }) => {
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [procFilter, setProcFilter] = useState(ALL);
  const [keyFilter, setKeyFilter] = useState('');

  const procOptions = useMemo<Option[]>(() => {
    const seen = new Map<string, Option>();
    for (const row of register.rows) {
      const value = procedureKey(row);
      if (!seen.has(value)) seen.set(value, { label: procedureLabel(row), value });
    }
    // Restricted rows are grouped under one option, listed last.
    const named = [...seen.values()].filter((o) => o.value !== RESTRICTED_TITLE).sort((a, b) => a.label.localeCompare(b.label));
    const restricted = seen.get(RESTRICTED_TITLE);
    return [{ label: 'All', value: ALL }, ...named, ...(restricted ? [restricted] : [])];
  }, [register.rows]);

  const filtered = useMemo(() => {
    const needle = keyFilter.trim().toUpperCase();
    const groups = new Map<string, RegisterRow[]>();
    for (const r of register.rows) groups.set(r.issueKey, [...(groups.get(r.issueKey) ?? []), r]);
    return [...groups.entries()]
      .filter(
        ([issueKey, rows]) =>
          (statusFilter === ALL || rows.some((r) => r.status === statusFilter)) &&
          (procFilter === ALL || rows.some((r) => procedureKey(r) === procFilter)) &&
          (needle === '' || issueKey.toUpperCase().includes(needle)),
      )
      .map(([issueKey, rows]) => ({ issueKey, rows }));
  }, [register.rows, statusFilter, procFilter, keyFilter]);

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        {STATUSES.map((s) => (
          <Lozenge key={s} appearance={LOZENGE[s]}>
            {`${s} ${register.counts[s]}`}
          </Lozenge>
        ))}
      </Inline>
      <Inline space="space.200" alignBlock="end">
        <Box xcss={filterBox}>
          <Stack space="space.050">
            <Label labelFor="canon-register-status">Status</Label>
            <Select
              inputId="canon-register-status"
              options={STATUS_OPTIONS}
              value={STATUS_OPTIONS.find((o) => o.value === statusFilter)}
              onChange={(o: unknown) => setStatusFilter(pickValue(o))}
            />
          </Stack>
        </Box>
        <Box xcss={filterBox}>
          <Stack space="space.050">
            <Label labelFor="canon-register-procedure">Procedure</Label>
            <Select
              inputId="canon-register-procedure"
              options={procOptions}
              value={procOptions.find((o) => o.value === procFilter)}
              onChange={(o: unknown) => setProcFilter(pickValue(o))}
            />
          </Stack>
        </Box>
        <Box xcss={filterBox}>
          <Stack space="space.050">
            <Label labelFor="canon-register-key">Work item key</Label>
            <Textfield
              id="canon-register-key"
              name="canon-register-key"
              placeholder="Filter by work item key"
              value={keyFilter}
              onChange={(e) => setKeyFilter(String(e.target.value ?? ''))}
            />
          </Stack>
        </Box>
      </Inline>
      <DynamicTable
        head={{
          cells: [
            { key: 'issue', content: 'Work item' },
            { key: 'procedure', content: 'Procedure' },
            { key: 'status', content: 'Status' },
            { key: 'boundAt', content: 'Bound at' },
          ],
        }}
        rows={filtered.map(({ issueKey, rows }) => {
          const top = mostUrgent(rows);
          return {
            key: issueKey,
            cells: [
              { key: 'issue', content: <Link href={`/browse/${issueKey}`}>{issueKey}</Link> },
              { key: 'procedure', content: rows.map(bindingText).join('; ') },
              {
                key: 'status',
                content: (
                  <Inline space="space.050" alignBlock="center">
                    <Lozenge appearance={LOZENGE[top]}>{top}</Lozenge>
                    {rows.some((r) => r.overridden) && <Text> · override</Text>}
                  </Inline>
                ),
              },
              { key: 'boundAt', content: rows.map((r) => r.boundAt.split('T')[0] ?? '').sort()[0] ?? '' },
            ],
          };
        })}
        rowsPerPage={20}
        emptyView={<Text>No bound work items yet.</Text>}
      />
    </Stack>
  );
};

const VerifySection = () => {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const verify = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    const r = await attempt<{ verification: Verification }>('canonRegisterVerify', {}, setError);
    if (r) {
      const { allOk, checked, results } = r.verification;
      if (allOk) {
        setNotice(`All ${checked} audit chains verified`);
      } else {
        const failed = results.filter((c) => !c.ok).map((c) => c.issueKey);
        setError(`Audit chain verification failed for: ${failed.join(', ')}`);
      }
    }
    setRunning(false);
  };

  return (
    <Stack space="space.100">
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
      <Inline space="space.100" alignBlock="center">
        <Button isDisabled={running} onClick={() => void verify()}>
          Verify audit chains
        </Button>
        {running && <Spinner size="medium" />}
      </Inline>
    </Stack>
  );
};

const App = () => {
  const [register, setRegister] = useState<Register | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void attempt<{ register: Register }>('canonRegister', {}, setError).then((r) => {
      if (r) setRegister(r.register);
      setLoading(false);
    });
  }, [tick]);

  return (
    <Stack space="space.300">
      <Text>Every work item bound to a Confluence procedure in this project.</Text>
      <Inline space="space.100" alignBlock="center">
        <Button isDisabled={loading} onClick={refresh}>
          Refresh
        </Button>
        {loading && <Spinner size="medium" />}
      </Inline>
      {error && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}
      {register && <RegisterView register={register} />}
      <VerifySection />
    </Stack>
  );
};

ForgeReconciler.render(<App />);
