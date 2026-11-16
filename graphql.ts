import { changedFiles, mergeTrees, type Store, type Repo, type Json } from './store.ts';

type Field = { name: string; alias: string; args: Json; fields: Field[]; on?: string; spread?: string };
// A tokenizing recursive descent parser: values remain symbolic until variable substitution.
function parse(source: string, variables: Json, operationName?: string) {
  const tokens = source.match(/\.\.\.|\$|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|[^\s,#]/g) ?? [];
  let i = 0;
  const take = () => { if (i >= tokens.length) throw Error('Unexpected end of document'); return tokens[i++]; };
  const expect = (s: string) => { if (take() !== s) throw Error(`Expected ${s}`); };
  function value(): any {
    const t = take();
    if (t === '$') return variables[take()];
    if (t === '{') { const o: Json = {}; while (tokens[i] !== '}') { const k = take(); expect(':'); o[k] = value(); } take(); return o; }
    if (t === '[') { const a = []; while (tokens[i] !== ']') a.push(value()); take(); return a; }
    if (t.startsWith('"')) return JSON.parse(t);
    if (/^-?\d/.test(t)) return Number(t);
    return t === 'null' ? null : t === 'true' ? true : t === 'false' ? false : t;
  }
  function fields(): Field[] {
    expect('{'); const out: Field[] = [];
    while (tokens[i] !== '}') {
      const t = take();
      if (t === '...') { const n = take(); out.push(n === 'on' ? { name: '', alias: '', args: {}, on: take(), fields: fields() } : { name: '', alias: '', args: {}, spread: n, fields: [] }); continue; }
      if (!/^[_A-Za-z]\w*$/.test(t)) throw Error(`Invalid field ${t}`);
      const f: Field = { name: t, alias: t, args: {}, fields: [] };
      if (tokens[i] === ':') { take(); f.name = take(); }
      if (tokens[i] === '(') { take(); while (tokens[i] !== ')') { const key = take(); expect(':'); f.args[key] = value(); } take(); }
      if (tokens[i] === '{') f.fields = fields(); out.push(f);
    }
    take(); return out;
  }
  const operations: { name?: string; type: string; fields: Field[] }[] = [], fragments: Record<string, Field> = {};
  while (i < tokens.length) {
    if (tokens[i] === 'fragment') { take(); const name = take(); expect('on'); const on = take(); fragments[name] = { name: '', alias: '', args: {}, on, fields: fields() }; continue; }
    let type = 'query', name;
    if (tokens[i] !== '{') {
      type = take(); if (!['query', 'mutation'].includes(type)) throw Error('Expected operation');
      if (tokens[i] !== '(' && tokens[i] !== '{') name = take();
      if (tokens[i] === '(') {
        take(); while (tokens[i] !== ')') { expect('$'); const key = take(); expect(':'); while (tokens[i] === '[' || tokens[i] === ']' || tokens[i] === '!' || /^[_A-Za-z]/.test(tokens[i] ?? '')) take(); if (tokens[i] === '=') { take(); const v = value(); if (variables[key] === undefined) variables[key] = v; } }
        take();
      }
    }
    operations.push({ type, name, fields: fields() });
  }
  const op = operationName ? operations.find(o => o.name === operationName) : operations.length === 1 ? operations[0] : undefined;
  if (!op) throw Error('Select one operation'); return { ...op, fragments };
}

// The schema is also the executor's field allowlist; introspection never advertises unsupported fields.
const schema: Record<string, Record<string, string>> = {
  Query: { viewer: 'User!', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema!' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  User: { id: 'ID!', login: 'String!' },
  Repository: { id: 'ID!', databaseId: 'Int', name: 'String!', nameWithOwner: 'String!', owner: 'User!', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean!', issue: 'Issue', issues: 'IssueConnection!', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection!' },
  Ref: { name: 'String!' }, Issue: { id: 'ID!', number: 'Int!', title: 'String!', body: 'String!', state: 'IssueState!' },
  PullRequest: { id: 'ID!', number: 'Int!', title: 'String!', body: 'String!', state: 'PullRequestState!', merged: 'Boolean!', headRefName: 'String!', baseRefName: 'String!', mergeable: 'MergeableState!', files: 'PullRequestChangedFileConnection' },
  PageInfo: { hasNextPage: 'Boolean!', endCursor: 'String', hasPreviousPage: 'Boolean!', startCursor: 'String' },
  IssueComment: { id: 'ID!', body: 'String!' }, IssueCommentEdge: { node: 'IssueComment' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' }, CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' }, MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' }, AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  PullRequestChangedFile: { path: 'String!' },
  __Type: { name: 'String', kind: '__TypeKind!', fields: '[__Field!]', enumValues: '[__EnumValue!]', ofType: '__Type' },
  __Field: { name: 'String!', type: '__Type!', isDeprecated: 'Boolean!', deprecationReason: 'String' }, __EnumValue: { name: 'String!', isDeprecated: 'Boolean!', deprecationReason: 'String' },
  __Schema: { types: '[__Type!]!', queryType: '__Type!', mutationType: '__Type' },
};
for (const [name, node] of Object.entries({ IssueConnection: 'Issue', PullRequestConnection: 'PullRequest', PullRequestChangedFileConnection: 'PullRequestChangedFile' })) schema[name] = { nodes: `[${node}]!`, totalCount: 'Int!', pageInfo: 'PageInfo!' };
const enums: Record<string, string[]> = { IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], SearchType: ['ISSUE', 'REPOSITORY', 'USER'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'] };
const id = (type: string, n: number) => Buffer.from(`${type}:${n}`).toString('base64');
const wrap = (type: string, data: any, repo?: Repo): any => data == null ? null : { type, data, repo };
function typeRef(s: string): any {
  if (s.endsWith('!')) return wrap('__Type', { kind: 'NON_NULL', ofType: typeRef(s.slice(0, -1)) });
  if (s.startsWith('[')) return wrap('__Type', { kind: 'LIST', ofType: typeRef(s.slice(1, -1)) });
  return wrap('__Type', { name: s, kind: enums[s] ? 'ENUM' : schema[s] ? 'OBJECT' : s === 'Node' ? 'INTERFACE' : 'SCALAR', ofType: null });
}
export async function graphql(store: Store, request: any, rest: (method: string, path: string, body: Json) => Promise<any>): Promise<any> {
  if (Array.isArray(request)) { const out = []; for (const op of request) out.push(await graphql(store, op, rest)); return out; }
  try {
    if (!request || typeof request.query !== 'string') throw Error('query must be a string');
    const op = parse(request.query, { ...request.variables }, request.operationName);
    function find(globalId: string): any {
      if (typeof globalId !== 'string') throw Error('Expected a node ID');
      const [type, n] = Buffer.from(globalId, 'base64').toString().split(':');
      for (const repo of store.repos.values()) {
        if (type === 'Repository' && repo.data.id === Number(n)) return wrap(type, repo.data, repo);
        const values = type === 'Issue' ? repo.issues.values() : type === 'PullRequest' ? repo.pulls.values() : [];
        for (const v of values) if (v.id === Number(n)) return wrap(type, v, repo);
      }
      return null;
    }
    async function field(obj: any, f: Field): Promise<any> {
      const { type, data: d, repo } = obj, a = f.args;
      if (f.name === '__typename') return type;
      if (!schema[type]?.[f.name]) throw Error(`Cannot query field "${f.name}" on type "${type}"`);
      if (type === '__Type' && f.name === 'fields') return schema[d.name] ? Object.entries(schema[d.name]).map(([name, type]) => wrap('__Field', { name, type: typeRef(type), isDeprecated: false, deprecationReason: null })) : null;
      if (type === '__Type' && f.name === 'enumValues') return enums[d.name]?.map(name => wrap('__EnumValue', { name, isDeprecated: false, deprecationReason: null })) ?? null;
      if (type === 'Query') {
        if (f.name === 'viewer') return wrap('User', store.viewer);
        if (f.name === 'repository') { const r = store.repos.get(`${a.owner}/${a.name}`.toLowerCase()); return r ? wrap('Repository', r.data, r) : null; }
        if (f.name === 'node') return find(a.id);
        if (f.name === '__type') return schema[a.name] || enums[a.name] ? typeRef(a.name) : null;
        if (f.name === '__schema') return wrap('__Schema', { types: [...Object.keys(schema), ...Object.keys(enums)].map(typeRef), queryType: typeRef('Query'), mutationType: typeRef('Mutation') });
      }
      if (type === 'Mutation') {
        const input = a.input; if (!input || typeof input !== 'object') throw Error('input is required');
        const target = find(input.repositoryId ?? input.issueId ?? input.pullRequestId ?? input.subjectId);
        if (!target) throw Error('Could not resolve node');
        const r = target.repo, path = `/repos/${r.data.full_name}`;
        let answer: any, result: any;
        if (f.name === 'createIssue') { if (target.type !== 'Repository') throw Error('Expected Repository'); answer = await rest('POST', `${path}/issues`, input); result = { issue: wrap('Issue', answer.data, r) }; }
        if (f.name === 'closeIssue') { if (target.type !== 'Issue') throw Error('Expected Issue'); answer = await rest('PATCH', `${path}/issues/${target.data.number}`, { state: 'closed' }); result = { issue: wrap('Issue', answer.data, r) }; }
        if (f.name === 'createPullRequest') { if (target.type !== 'Repository') throw Error('Expected Repository'); answer = await rest('POST', `${path}/pulls`, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName }); result = { pullRequest: wrap('PullRequest', answer.data, r) }; }
        if (f.name === 'mergePullRequest') { if (target.type !== 'PullRequest') throw Error('Expected PullRequest'); if (input.mergeMethod && !enums.PullRequestMergeMethod.includes(input.mergeMethod)) throw Error('Invalid mergeMethod'); answer = await rest('PUT', `${path}/pulls/${target.data.number}/merge`, { merge_method: (input.mergeMethod ?? 'MERGE').toLowerCase() }); result = { pullRequest: target }; }
        if (f.name === 'addComment') { if (!['Issue', 'PullRequest'].includes(target.type)) throw Error('Expected comment subject'); answer = await rest('POST', `${path}/issues/${target.data.number}/comments`, { body: input.body }); result = { commentEdge: wrap('IssueCommentEdge', { node: wrap('IssueComment', answer.data, r) }) }; }
        if (answer.status >= 400) throw Error(answer.data?.message ?? 'Mutation failed');
        return wrap(schema.Mutation[f.name], { ...result, clientMutationId: input.clientMutationId ?? null });
      }
      if (f.name === 'id') return id(type, d.id);
      if (type === 'Repository') {
        if (f.name === 'databaseId') return d.id;
        if (f.name === 'nameWithOwner') return d.full_name;
        if (f.name === 'owner') return wrap('User', d.owner);
        if (f.name === 'defaultBranchRef') return repo.refs.has(`refs/heads/${d.default_branch}`) ? wrap('Ref', { name: d.default_branch }) : null;
        if (f.name === 'viewerPermission') return 'ADMIN';
        if (f.name === 'hasIssuesEnabled') return true;
        if (f.name === 'issue') return wrap('Issue', repo.issues.get(a.number)?.pull_request ? null : repo.issues.get(a.number), repo);
        if (f.name === 'pullRequest') return wrap('PullRequest', repo.pulls.get(a.number), repo);
        if (['issues', 'pullRequests'].includes(f.name)) {
          const isIssue = f.name === 'issues'; let items = [...(isIssue ? repo.issues : repo.pulls).values()].filter(v => !isIssue || !v.pull_request);
          if (a.states) items = items.filter(v => a.states.includes(v.merged ? 'MERGED' : v.state.toUpperCase()));
          const key = a.orderBy?.field === 'COMMENTS' ? 'comments' : a.orderBy?.field === 'UPDATED_AT' ? 'updated_at' : 'created_at';
          items.sort((x, y) => (a.orderBy?.direction === 'DESC' ? -1 : 1) * (String(x[key]).localeCompare(String(y[key])) || x.number - y.number));
          return connection(isIssue ? 'Issue' : 'PullRequest', items.map(v => wrap(isIssue ? 'Issue' : 'PullRequest', v, repo)), a);
        }
      }
      if (type === 'Issue' || type === 'PullRequest') {
        if (f.name === 'state') return d.merged ? 'MERGED' : d.state.toUpperCase();
        if (f.name === 'headRefName') return d.head.ref;
        if (f.name === 'baseRefName') return d.base.ref;
        if (f.name === 'mergeable') return mergeTrees(repo.commits.get(d.base.sha)!.tree, repo.commits.get(repo.refs.get(`refs/heads/${d.base.ref}`)!)!.tree, repo.commits.get(d.head.sha)!.tree) ? 'MERGEABLE' : 'CONFLICTING';
        if (f.name === 'files') return connection('PullRequestChangedFile', changedFiles(repo.commits.get(d.base.sha)!.tree, repo.commits.get(d.head.sha)!.tree).map(v => wrap('PullRequestChangedFile', { path: v.filename })), a);
      }
      return d[f.name] ?? null;
    }
    function connection(type: string, items: any[], a: Json) {
      const start = a.after == null ? 0 : Number(Buffer.from(a.after, 'base64').toString().replace('cursor:', '')) + 1;
      const count = a.first ?? 100; if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0) throw Error('Invalid pagination arguments');
      const nodes = items.slice(start, start + count), cursor = (n: number) => id('cursor', n);
      return wrap(`${type}Connection`, { nodes, totalCount: items.length, pageInfo: wrap('PageInfo', { hasNextPage: start + nodes.length < items.length, endCursor: nodes.length ? cursor(start + nodes.length - 1) : null, startCursor: nodes.length ? cursor(start) : null, hasPreviousPage: start > 0 }) });
    }
    async function execute(obj: any, fields: Field[], depth = 0): Promise<any> {
      if (depth > 80) throw Error('Selection nesting limit');
      if (obj == null) return null;
      if (Array.isArray(obj)) return Promise.all(obj.map(v => execute(v, fields, depth + 1)));
      const out: Json = {};
      for (const f of fields) {
        if (f.spread || f.on) { const fragment = f.spread ? op.fragments[f.spread] : f; if (!fragment) throw Error('Unknown fragment'); if (fragment.on === obj.type || fragment.on === 'Node') Object.assign(out, await execute(obj, fragment.fields, depth + 1)); continue; }
        const v = await field(obj, f);
        if (f.fields.length) { if (v != null && !Array.isArray(v) && !v.type) throw Error('Scalar field has a selection'); out[f.alias] = await execute(v, f.fields, depth + 1); }
        else { if (v?.type || Array.isArray(v)) throw Error('Object field requires a selection'); out[f.alias] = v; }
      }
      return out;
    }
    function validate(type: string, fields: Field[], depth = 0): void {
      if (depth > 80) throw Error('Selection nesting limit');
      for (const f of fields) {
        if (f.spread || f.on) {
          const fragment = f.spread ? op.fragments[f.spread] : f;
          if (!fragment) throw Error('Unknown fragment');
          if (!schema[fragment.on!] && fragment.on !== 'Node') throw Error('Unknown fragment type');
          validate(fragment.on!, fragment.fields, depth + 1); continue;
        }
        const ref = f.name === '__typename' ? 'String!' : type === 'Node' && f.name === 'id' ? 'ID!' : schema[type]?.[f.name];
        if (!ref) throw Error(`Cannot query field "${f.name}" on type "${type}"`);
        const child = ref.replace(/[!\[\]]/g, '');
        if (Boolean(schema[child] || child === 'Node') !== Boolean(f.fields.length)) throw Error(`Invalid selection for ${f.name}`);
        if (f.fields.length) validate(child, f.fields, depth + 1);
      }
    }
    validate(op.type === 'mutation' ? 'Mutation' : 'Query', op.fields);
    return { data: await execute(wrap(op.type === 'mutation' ? 'Mutation' : 'Query', {}), op.fields) };
  } catch (error) { return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] }; }
}
