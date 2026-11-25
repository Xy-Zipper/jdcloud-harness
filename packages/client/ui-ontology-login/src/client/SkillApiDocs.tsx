/** HTTP reference for the current published Skill, with this deployment's URLs. */
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { OntologyLoginKey } from './locales.ts'
import css from './Knowledge.module.css'

type Copy = PropsLocale<'ontology.login'>
type Parameter = readonly [field: string, type: string, label: OntologyLoginKey]
const pagination = [
  ['page', 'integer', 'knowledgeApiPageParam'],
  ['pageSize', 'integer', 'knowledgeApiSizeParam'],
] as const satisfies readonly Parameter[]
const pageFields = [
  ['page', 'integer', 'knowledgeApiOutPage'],
  ['pageSize', 'integer', 'knowledgeApiOutPageSize'],
  ['hasMore', 'boolean', 'knowledgeApiOutHasMore'],
] as const satisfies readonly Parameter[]
const sessionFields = [
  ['id', 'string', 'knowledgeApiOutSessionId'],
  ['name', 'string', 'knowledgeApiOutSessionName'],
  ['turnCount', 'integer', 'knowledgeApiOutTurnCount'],
  ['createdAt', 'string', 'knowledgeApiOutCreatedAt'],
  ['updatedAt', 'string', 'knowledgeApiOutUpdatedAt'],
] as const satisfies readonly Parameter[]
const answerFields = [
  ['answer', 'string', 'knowledgeApiOutAnswer'],
  ['sources', 'object[]', 'knowledgeApiOutSources'],
  ['version', 'integer', 'knowledgeApiOutVersion'],
] as const satisfies readonly Parameter[]
const citationFields = [
  ['citationId', 'string', 'knowledgeApiOutCitationId'],
  ['text', 'string', 'knowledgeApiOutExcerpt'],
  ['projectId', 'string', 'knowledgeApiOutProject'],
  ['fileId', 'string', 'knowledgeApiOutFile'],
  ['fileName', 'string', 'knowledgeApiOutFileName'],
  ['mediaType', 'string', 'knowledgeApiOutMediaType'],
  ['knowledgeBaseId', 'string', 'knowledgeApiOutDataset'],
  ['documentId', 'string', 'knowledgeApiOutDocument'],
  ['chunkId', 'string', 'knowledgeApiOutChunk'],
  ['nodeIds', 'string[]', 'knowledgeApiOutNodes'],
  ['nodeId', 'string', 'knowledgeApiOutNode'],
  ['page', 'integer', 'knowledgeApiOutOriginalPage'],
  ['endPage', 'integer', 'knowledgeApiOutEndPage'],
] as const satisfies readonly Parameter[]
const errorFields = [
  ['code', 'string', 'knowledgeApiOutErrorCode'],
  ['message', 'string', 'knowledgeApiOutErrorMessage'],
  ['requestId', 'string', 'knowledgeApiOutRequestId'],
] as const satisfies readonly Parameter[]
const sessionId = 'ss_example'

function under(path: string, fields: readonly Parameter[]): Parameter[] {
  return fields.map(([name, type, description]) => [`${path}.${name}`, type, description])
}

function Fields({ fields, t }: Copy & { fields: readonly Parameter[] }) {
  return <dl className={css.apiParams}>{fields.map(([name, type, description]) => <div key={name}>
    <dt><code>{name}</code> <small>{type}</small></dt><dd>{t(description)}</dd>
  </div>)}</dl>
}

/** Group each method with its input, curl example, and status and response body. */
export function SkillApiDocs({ base, t }: Copy & { base: URL }) {
  const question = t('knowledgeExampleQuestion')
  const session = { id: sessionId, name: t('knowledgeApiExampleName'), turnCount: 0,
    createdAt: '2026-11-20T01:00:00Z', updatedAt: '2026-11-20T01:00:00Z' }
  const answer = { answer: t('knowledgeApiExampleAnswer'), sources: [{
    citationId: 'R-0123456789', projectId: 'project_example', fileId: 'file_example', fileName: 'training.pdf', mediaType: 'application/pdf',
    knowledgeBaseId: 'kb_example', documentId: 'doc_example', chunkId: 'chunk_example', nodeIds: ['0001'], page: 4, text: t('knowledgeApiExampleAnswer'),
  }], version: 1 }
  const chatInput = { question, sessionId, stream: false }
  const chatResult = { ...answer, sessionId, number: 1 }
  const endpoints: readonly {
    label: OntologyLoginKey
    method: 'POST' | 'GET' | 'DELETE'
    path: string
    example: string
    parameters: readonly Parameter[]
    input?: object
    status: number
    output?: object
    fields?: readonly Parameter[]
  }[] = [
    { label: 'knowledgeApiCreate', method: 'POST', path: 'sessions', example: 'sessions', status: 201,
      parameters: [['name', 'string', 'knowledgeApiNameParam']], input: { name: session.name }, output: session, fields: sessionFields },
    { label: 'knowledgeApiChat', method: 'POST', path: 'chat', example: 'chat', status: 200,
      parameters: [['question', 'string', 'knowledgeApiQuestionParam'], ['sessionId', 'string', 'knowledgeApiChatSessionParam'],
        ['stream', 'boolean', 'knowledgeApiStreamParam']], input: chatInput, output: chatResult,
      fields: [...answerFields, ['sessionId', 'string', 'knowledgeApiOutSavedSession'], ['number', 'integer', 'knowledgeApiOutSavedNumber']] },
    { label: 'knowledgeApiList', method: 'GET', path: 'sessions', example: 'sessions?page=1&pageSize=20', status: 200,
      parameters: pagination, output: { sessions: [session], page: 1, pageSize: 20, hasMore: false },
      fields: [['sessions', 'object[]', 'knowledgeApiOutSessions'], ...under('sessions[]', sessionFields), ...pageFields] },
    { label: 'knowledgeApiHistory', method: 'GET', path: 'sessions/{sessionId}', example: `sessions/${sessionId}?page=1&pageSize=20`, status: 200,
      parameters: [['sessionId', 'string', 'knowledgeApiPathParam'], ...pagination], output: { session: { ...session, turnCount: 1 },
        turns: [{ number: 1, question, ...answer, createdAt: session.createdAt }], page: 1, pageSize: 20, hasMore: false },
      fields: [['session', 'object', 'knowledgeApiOutSession'], ...under('session', sessionFields), ['turns', 'object[]', 'knowledgeApiOutTurns'],
        ...under('turns[]', [['number', 'integer', 'knowledgeApiOutNumber'], ['question', 'string', 'knowledgeApiOutQuestion'],
          ['createdAt', 'string', 'knowledgeApiOutTurnDate'], ...answerFields]), ...pageFields] },
    { label: 'knowledgeApiDelete', method: 'DELETE', path: 'sessions/{sessionId}', example: `sessions/${sessionId}`, status: 204,
      parameters: [['sessionId', 'string', 'knowledgeApiPathParam']] },
  ]
  const codeLabels = { copyLabel: t('knowledgeCopyValue'), copiedLabel: t('knowledgeCopied') }
  const curl = (method: string, path: string, input?: object, stream = false) => [
    `curl ${stream ? '--no-buffer ' : ''}--request ${method} '${new URL(path, base).href}'`,
    "  --header 'Authorization: Bearer <API_KEY>'",
    ...(input === undefined ? [] : ["  --header 'Content-Type: application/json'", `  --data '${JSON.stringify(input)}'`]),
  ].join(' \\\n')
  return <section className={css.apiDocs} aria-label={t('knowledgeAPIDocs')}>
    <h3>{t('knowledgeAPIDocs')}</h3>
    <p className={css.releaseHint}>{t('knowledgeAPIInput')}</p>
    <p className={css.apiEndpoint}><code>{base.href}</code></p>
    <Fields t={t} fields={[
      ['skillId', 'string', 'knowledgeApiSkillParam'], ['Authorization', 'header', 'knowledgeApiAuthParam'],
      ['Content-Type', 'header', 'knowledgeApiMediaParam'], ['X-Request-ID', 'header', 'knowledgeApiRequestIdParam'],
    ]} />
    {endpoints.map(({ label, method, path, example, parameters, input, status, output, fields }) =>
      <details key={label} className={css.apiOperation}>
        <summary><span>{t(label)}</span> <code>{method} /{path}</code></summary>
        <div className={css.apiDetails}>
          <h4>{t('knowledgeApiRequest')}</h4>
          <Fields fields={parameters} t={t} />
          <h4>{t('knowledgeAPICurl')}</h4>
          <CodeBlock code={curl(method, example, input)} lang="bash" {...codeLabels} />
          {label === 'knowledgeApiChat' && <>
            <h4>{t('knowledgeApiStreamCurl')}</h4>
            <CodeBlock code={curl(method, example, { ...chatInput, stream: true }, true)} lang="bash" {...codeLabels} />
          </>}
          {fields !== undefined && <>
            <h4>{t('knowledgeApiResponseFields')}</h4>
            <Fields fields={fields} t={t} />
          </>}
          {(label === 'knowledgeApiChat' || label === 'knowledgeApiHistory') && <details>
            <summary>{t('knowledgeApiCitationFields')}</summary>
            <Fields fields={citationFields} t={t} />
          </details>}
          <h4>{t('knowledgeApiResponse', { status: String(status) })}</h4>
          {output === undefined ? <p className={css.releaseHint}>{t('knowledgeApiNoBody')}</p>
            : <CodeBlock code={JSON.stringify(output, null, 2)} lang="json" {...codeLabels} />}
          {label === 'knowledgeApiChat' && <>
            <h4>{t('knowledgeApiStreamTitle')}</h4>
            <p className={css.releaseHint}>{t('knowledgeApiStreamHint')}</p>
            <Fields t={t} fields={[
              ['delta', 'event', 'knowledgeApiEventDelta'], ['text', 'string', 'knowledgeApiOutDeltaText'],
              ['done', 'event', 'knowledgeApiEventDone'], ['error', 'event', 'knowledgeApiEventError'],
              ['status', 'integer', 'knowledgeApiOutErrorStatus'], ...errorFields,
            ]} />
            <CodeBlock code={[answer.answer.slice(0, 6), answer.answer.slice(6)].map(text => `event: delta\ndata: ${JSON.stringify({ text })}\n\n`).join('')
              + `event: done\ndata: ${JSON.stringify(chatResult)}\n\n`}
            lang="text" {...codeLabels} />
          </>}
        </div>
      </details>,
    )}
    <details className={css.apiOperation}>
      <summary>{t('knowledgeApiErrorsTitle')}</summary>
      <div className={css.apiDetails}>
        <p className={css.releaseHint}>{t('knowledgeAPIErrors')}</p>
        <Fields fields={errorFields} t={t} />
      </div>
    </details>
  </section>
}
