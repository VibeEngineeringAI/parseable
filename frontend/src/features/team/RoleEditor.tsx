import { useCallback, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Input, Select, Sheet, InlineError } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { createId } from '../../lib/ids';
import type { Privilege, PrivilegeName, Roles } from '../../lib/types';
import { privilegeNames, validateName } from './helpers';
import { useMutation } from '../../hooks/useMutation';

type Row = { id: string; privilege: PrivilegeName; dataset: string };
const newRow = (): Row => ({ id: createId(), privilege: 'reader', dataset: '*' });
function rowPrivilege(row: Row): Privilege {
  return row.privilege === 'admin' || row.privilege === 'editor'
    ? { privilege: row.privilege }
    : { privilege: row.privilege, resource: { stream: row.dataset } };
}

export function RoleEditor({
  roles,
  name: existing,
  onClose,
  onChanged,
}: {
  roles: Roles;
  name?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client } = useApp();
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const mutation = useMutation();
  const nameError =
    !existing && name
      ? validateName(name, 'role') ||
        (Object.hasOwn(roles, name) ? 'Role already exists' : undefined)
      : undefined;
  const actions = rows.map(rowPrivilege);
  const combined = [...(existing ? roles[existing] : []), ...actions];
  const duplicate = new Set(combined.map((item) => JSON.stringify(item))).size !== combined.length;
  const valid =
    (existing || (name && !validateName(name, 'role') && !Object.hasOwn(roles, name))) &&
    !duplicate;
  function update(id: string, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    void mutation.run(async () => {
      await client.putRole(existing || name, combined);
      if (mutation.isActive()) onClose();
      onChanged();
    });
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={existing ? 'Add privilege to role' : 'Create new role'}
      description={
        existing ? `Add access to ${existing}.` : 'Choose a name and privileges for this role.'
      }
    >
      <form className="stack" onSubmit={submit}>
        {!existing && (
          <Input
            label="Role name"
            value={name}
            required
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            error={nameError}
            disabled={mutation.pending}
          />
        )}
        <QueryState loading={datasets.loading} error={datasets.error} retry={datasets.reload} />
        {rows.map((row, index) => (
          <fieldset className="team-privilege-row" key={row.id} disabled={mutation.pending}>
            <legend>Privilege {index + 1}</legend>
            <Select
              label="Privilege"
              value={row.privilege}
              onChange={(event) =>
                update(row.id, { privilege: event.target.value as PrivilegeName })
              }
            >
              {privilegeNames.map((privilege) => (
                <option key={privilege}>{privilege}</option>
              ))}
            </Select>
            {['reader', 'writer', 'ingestor'].includes(row.privilege) && (
              <Select
                label="Dataset"
                value={row.dataset}
                onChange={(event) => update(row.id, { dataset: event.target.value })}
              >
                <option value="*">All datasets</option>
                {datasets.data?.map((dataset) => (
                  <option key={dataset.name}>{dataset.name}</option>
                ))}
              </Select>
            )}
            {rows.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove privilege row ${index + 1}`}
                onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
              >
                <X size={14} aria-hidden="true" /> Remove row
              </Button>
            )}
          </fieldset>
        ))}
        <Button
          onClick={() => setRows((current) => [...current, newRow()])}
          disabled={mutation.pending}
        >
          <Plus size={15} aria-hidden="true" /> Add another privilege
        </Button>
        <InlineError
          error={duplicate ? 'This privilege is already in the role.' : mutation.error}
        />
        <Button
          type="submit"
          variant="primary"
          data-dialog-confirm
          disabled={!valid || mutation.pending}
        >
          {mutation.pending ? 'Saving…' : existing ? 'Add privilege' : 'Create role'}
        </Button>
      </form>
    </Sheet>
  );
}
