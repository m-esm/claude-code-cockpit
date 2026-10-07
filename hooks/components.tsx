import type { Elements, RenderChildren, RenderElement, RenderNode, RenderSurface } from 'claude-code'

import type { Feed, HookRow, HooksSnapshot, Interview, Meter, OpenItem, Panel, QuotaSnapshot, Sections, Slot, SsaRun, SsaSnapshot } from '../types'
import type { Tone } from './charts'
import { clarityChart, clarityTone, hooksChart, hookTone, pctTone, progressBar, quotaChart, quotaRows, runStrip, runTone } from './charts'
import { lowestWindow } from './feeds'
import { ago, clock, duration, sparkline, until } from './format'
import { STOP_EVERY } from './interview'
import { bar, trend } from './meter'

export type Ui = Elements[RenderSurface]

export type SectionKey = keyof Sections

export type CockpitActions = {
  toggle: (key: SectionKey) => void
  cancelPanel: () => void
  refresh: () => void
  openPane: () => void
  hideBand: () => void
}

export type CockpitData = {
  now: number
  width: number
  meter: Meter | null
  interview: Interview
  panel: Panel
  quota: Feed<QuotaSnapshot>
  hooks: Feed<HooksSnapshot>
  ssa: Feed<SsaSnapshot>
  open: Sections
}

const TEXT_COLOR: Record<Tone, string> = { good: 'green', warn: 'yellow', bad: 'red', info: 'cyan', muted: 'gray' }

const IMPACT_TONE: Record<string, Tone> = { high: 'bad', medium: 'warn', low: 'muted' }

const SLOT_MARK: Record<Slot['state'], { mark: string; tone: Tone }> = {
  settled: { mark: '✓', tone: 'good' },
  partial: { mark: '◐', tone: 'warn' },
  open: { mark: '○', tone: 'muted' },
}

const chartWidth = (columns: number): number => Math.max(260, Math.min(620, Math.round(columns * 7.2) - 40))

const pips = (filled: number, total: number): string => '●'.repeat(Math.min(filled, total)) + '○'.repeat(Math.max(0, total - filled))

function Pill({ ui, tone, label, key }: { ui: Ui; tone: Tone; label: string; key?: string }): RenderNode {
  const { Box, Text } = ui
  return (
    <Box key={key} borderStyle="round" borderColor={TEXT_COLOR[tone]} paddingX={1}>
      <Text color={TEXT_COLOR[tone]} wrap="truncate-end">{label}</Text>
    </Box>
  )
}

function Chart({ ui, source, alt, width, fallback }: { ui: Ui; source: string; alt: string; width: number; fallback: RenderChildren }): RenderNode {
  const { Box } = ui
  if ('Svg' in ui) {
    const { Svg } = ui
    return <Svg source={source} alt={alt} width={width} />
  }
  return <Box flexDirection="column">{fallback}</Box>
}

function Caption({ ui, children }: { ui: Ui; children: RenderChildren }): RenderNode {
  const { Text } = ui
  return <Text dimColor wrap="wrap">{children}</Text>
}

function Label({ ui, children }: { ui: Ui; children: RenderChildren }): RenderNode {
  const { Text } = ui
  return <Text bold>{children}</Text>
}

function FeedNotice({ ui, feed, now }: { ui: Ui; feed: Feed<unknown>; now: number }): RenderNode | null {
  const { Box, Text } = ui
  if (feed.status === 'loading') return <Caption ui={ui}>Loading…</Caption>
  if (feed.status !== 'error') return null
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      <Text color="red" bold>Feed error</Text>
      <Text color="red" wrap="wrap">{feed.error}</Text>
      {feed.lastOkAt ? <Caption ui={ui}>Showing data from {ago(feed.lastOkAt, now)}.</Caption> : null}
    </Box>
  )
}

function Card({
  ui,
  sectionKey,
  title,
  summary,
  tone,
  isOpen,
  onToggle,
  children,
}: {
  ui: Ui
  sectionKey: SectionKey
  title: string
  summary: string
  tone: Tone
  isOpen: boolean
  onToggle: () => void
  children: RenderChildren
}): RenderNode {
  const { Box, Button, Text } = ui
  return (
    <Box key={`card-${sectionKey}`} flexDirection="column" borderStyle="round" borderColor={isOpen ? TEXT_COLOR[tone] : 'gray'} borderDimColor={!isOpen} paddingX={1} marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Button key={`toggle-${sectionKey}`} label={`${isOpen ? '▾' : '▸'}  ${title}`} plain onPress={onToggle} />
        <Text color={TEXT_COLOR[tone]} wrap="truncate-end">● {summary}</Text>
      </Box>
      {isOpen ? (
        <Box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
          {children}
        </Box>
      ) : null}
    </Box>
  )
}

function Tile({ ui, label, value, tone, key }: { ui: Ui; label: string; value: string; tone: Tone; key: string }): RenderNode {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="column" flexGrow={1} minWidth={16} borderStyle="round" borderColor={TEXT_COLOR[tone]} paddingX={1}>
      <Text dimColor>{label}</Text>
      <Text bold color={TEXT_COLOR[tone]} wrap="truncate-end">{value}</Text>
    </Box>
  )
}

export const questioningTone = (meter: Meter | null): Tone =>
  meter === null ? 'muted' : meter.status === 'interviewing' ? clarityTone(meter.clarity) : 'muted'

export const quotaTone = (feed: Feed<QuotaSnapshot>): Tone => {
  if (feed.status === 'error') return 'bad'
  const lowest = lowestWindow(feed.data)
  return lowest ? pctTone(lowest.window.remainingPct) : 'muted'
}

export const hooksTone = (feed: Feed<HooksSnapshot>, now: number): Tone => {
  if (feed.status === 'error') return 'bad'
  const block = feed.data?.lastBlock
  if (block && now - block.at < 10 * 60 * 1000) return 'bad'
  return (feed.data?.inflight ?? 0) > 0 ? 'info' : 'good'
}

export const ssaTone = (feed: Feed<SsaSnapshot>): Tone => {
  if (feed.status === 'error') return 'bad'
  if ((feed.data?.running.length ?? 0) > 0) return 'info'
  return feed.data?.recent[0]?.state === 'failed' ? 'warn' : 'good'
}

function Overview({ ui, data }: { ui: Ui; data: CockpitData }): RenderNode {
  const { Box } = ui
  const { meter, quota, hooks, ssa, now } = data
  const lowest = lowestWindow(quota.data)
  const running = ssa.data?.running.length ?? 0
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      <Tile ui={ui} key="tile-q" label="Clarity" value={meter ? `${meter.clarity}/10 ${meter.status === 'interviewing' ? trend(meter.history) : meter.status}` : 'no interview'} tone={questioningTone(meter)} />
      <Tile ui={ui} key="tile-quota" label="Tightest quota" value={lowest ? `${lowest.cli} ${lowest.window.remainingPct}%` : quota.status} tone={quotaTone(quota)} />
      <Tile ui={ui} key="tile-hooks" label="Hooks" value={hooks.data?.lastBlock && now - hooks.data.lastBlock.at < 600000 ? `blocked ${ago(hooks.data.lastBlock.at, now)}` : `${hooks.data?.inflight ?? 0} running`} tone={hooksTone(hooks, now)} />
      <Tile ui={ui} key="tile-ssa" label="Subagents" value={running ? `${running} running` : `${ssa.data?.recent.length ?? 0} recent`} tone={ssaTone(ssa)} />
    </Box>
  )
}

function SlotChips({ ui, slots, settled, open }: { ui: Ui; slots: readonly Slot[]; settled: readonly string[]; open: readonly string[] }): RenderNode {
  const { Box } = ui
  const items: { label: string; state: Slot['state'] }[] = slots.length
    ? slots.map(slot => ({ label: slot.label, state: slot.state }))
    : [...settled.map(label => ({ label, state: 'settled' as const })), ...open.map(label => ({ label, state: 'open' as const }))]
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {items.map((item, index) => (
        <Pill ui={ui} key={`slot-${index}`} tone={SLOT_MARK[item.state].tone} label={`${SLOT_MARK[item.state].mark} ${item.label}`} />
      ))}
    </Box>
  )
}

function OpenItems({ ui, items, costs }: { ui: Ui; items: readonly OpenItem[]; costs: readonly string[] }): RenderNode | null {
  const { Box, Text } = ui
  if (items.length === 0 && costs.length === 0) return null
  return (
    <Box flexDirection="column">
      <Label ui={ui}>Open questions</Label>
      {items.length
        ? items.map((item, index) => (
            <Box key={`item-${index}`} flexDirection="row" gap={1}>
              <Text color={TEXT_COLOR[IMPACT_TONE[item.impact] ?? 'muted']} bold>{item.impact.toUpperCase().padEnd(6)}</Text>
              <Box flexDirection="column" flexShrink={1}>
                <Text wrap="wrap">{item.question || item.id}</Text>
                {item.costOfWrong ? <Caption ui={ui}>If wrong: {item.costOfWrong}</Caption> : null}
              </Box>
            </Box>
          ))
        : costs.map((cost, index) => <Text key={`cost-${index}`} wrap="wrap">• {cost}</Text>)}
    </Box>
  )
}

function PanelBox({ ui, panel, now, width, onCancel }: { ui: Ui; panel: Panel; now: number; width: number; onCancel: () => void }): RenderNode | null {
  const { Box, Button, Text } = ui
  if (panel.phase === 'idle') return null
  const tone: Tone = panel.phase === 'failed' ? 'bad' : panel.phase === 'countdown' ? 'warn' : panel.phase === 'running' ? 'info' : panel.phase === 'done' ? 'good' : 'muted'
  const remaining = panel.phase === 'countdown' ? Math.max(0, panel.deadline - now) : 0
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={TEXT_COLOR[tone]} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text bold color={TEXT_COLOR[tone]}>Auto panel · {panel.phase}</Text>
        {panel.phase === 'countdown' ? <Button key="cancel-panel" label="Cancel" hotkey="x" variant="primary" onPress={onCancel} /> : null}
      </Box>
      <Text wrap="wrap">{panel.label}</Text>
      {panel.phase === 'countdown' ? (
        <Chart ui={ui} source={progressBar(1 - remaining / 30000, 'warn', width - 24)} alt={`Starts in ${Math.ceil(remaining / 1000)} seconds`} width={width - 24} fallback={<Text color="yellow">{bar(10 - remaining / 3000)} {Math.ceil(remaining / 1000)}s</Text>} />
      ) : null}
      {panel.phase === 'running' && panel.startedAt ? <Caption ui={ui}>Running for {duration(now - panel.startedAt)}</Caption> : null}
      <Caption ui={ui}>{panel.message}</Caption>
    </Box>
  )
}

function QuestioningSection({ ui, data, actions }: { ui: Ui; data: CockpitData; actions: CockpitActions }): RenderNode {
  const { Box, Text } = ui
  const { meter, interview, panel, now, width, open } = data
  const tone = questioningTone(meter)
  const summary = meter ? `${meter.clarity}/10 · ${meter.status}${meter.source === 'text' ? ' (read from text)' : ''}` : 'no interview'
  const body = meter
    ? [
        meter.topic || meter.phase ? (
          <Box key="q-head" flexDirection="row" flexWrap="wrap" gap={1}>
            {meter.topic ? <Text bold>{meter.topic}</Text> : null}
            {meter.phase ? <Pill ui={ui} key="phase" tone="info" label={meter.phase} /> : null}
          </Box>
        ) : null,
        <Chart
          ui={ui}
          key="q-chart"
          source={clarityChart(meter.clarity, meter.history, width)}
          alt={`Clarity ${meter.clarity} of 10, history ${meter.history.join(', ')}`}
          width={width}
          fallback={<Text color={TEXT_COLOR[tone]}>{bar(meter.clarity, 20)} {meter.clarity}/10 {trend(meter.history)} {sparkline(meter.history)}</Text>}
        />,
        meter.picture ? (
          <Box key="q-picture" flexDirection="column">
            <Label ui={ui}>Picture</Label>
            <Text wrap="wrap">{meter.picture}</Text>
          </Box>
        ) : null,
        meter.buildNow || meter.assuming ? (
          <Box key="q-build" flexDirection="column">
            {meter.buildNow ? <Label ui={ui}>Would build now</Label> : null}
            {meter.buildNow ? <Text wrap="wrap">{meter.buildNow}</Text> : null}
            {meter.assuming ? <Caption ui={ui}>Assuming {meter.assuming}</Caption> : null}
          </Box>
        ) : null,
        <Box key="q-slots" flexDirection="column">
          <Label ui={ui}>Slots</Label>
          <SlotChips ui={ui} slots={meter.slots ?? []} settled={meter.settled} open={meter.open} />
        </Box>,
        <OpenItems ui={ui} key="q-items" items={meter.openItems ?? []} costs={meter.costOfWrong} />,
        meter.lensesCovered.length || meter.lensesThin.length ? (
          <Box key="q-lenses" flexDirection="row" flexWrap="wrap" gap={1}>
            {meter.lensesCovered.map((lens, index) => <Pill ui={ui} key={`lc-${index}`} tone="good" label={lens} />)}
            {meter.lensesThin.map((lens, index) => <Pill ui={ui} key={`lt-${index}`} tone="warn" label={`${lens} (thin)`} />)}
          </Box>
        ) : null,
        meter.shifted ? <Caption ui={ui} key="q-shifted">Shifted: {meter.shifted}</Caption> : null,
        <Box key="q-enforcer" flexDirection="column">
          <Label ui={ui}>Enforcer</Label>
          <Text>
            {interview.id ? `${pips(interview.answersSinceStop, STOP_EVERY)}  ${interview.answersSinceStop}/${STOP_EVERY} answers to the next stop check` : 'Idle until a meter "start"'}
          </Text>
          <Caption ui={ui}>
            {interview.totalAnswers} answers · {interview.stopChecks} stop checks · {interview.blocks} blocked
          </Caption>
          {interview.warnings.slice(-2).map((warning, index) => (
            <Text key={`warn-${index}`} color="yellow" wrap="wrap">⚠ {warning}</Text>
          ))}
        </Box>,
        <PanelBox ui={ui} key="q-panel" panel={panel} now={now} width={width} onCancel={actions.cancelPanel} />,
      ]
    : [<Caption ui={ui} key="q-empty">No interview yet. Run /questioning and the meter fills in here as questions go out.</Caption>]
  return (
    <Card ui={ui} sectionKey="questioning" title="Questioning" summary={summary} tone={tone} isOpen={open.questioning} onToggle={() => actions.toggle('questioning')}>
      {body}
    </Card>
  )
}

function QuotaSection({ ui, data, actions }: { ui: Ui; data: CockpitData; actions: CockpitActions }): RenderNode {
  const { Box, Text } = ui
  const { quota, now, width, open } = data
  const snapshot = quota.data
  const rows = snapshot ? quotaRows(snapshot.clis, snapshot.primary, iso => until(iso, now)) : []
  const lowest = lowestWindow(snapshot)
  const summary = lowest ? `tightest ${lowest.cli} ${lowest.window.remainingPct}%` : quota.status
  return (
    <Card ui={ui} sectionKey="quota" title="Quota" summary={summary} tone={quotaTone(quota)} isOpen={open.quota} onToggle={() => actions.toggle('quota')}>
      <FeedNotice ui={ui} feed={quota} now={now} />
      {rows.length ? (
        <Chart
          ui={ui}
          source={quotaChart(rows, width)}
          alt={rows.map(row => `${row.cli} ${row.pct ?? '?'}%`).join(', ')}
          width={width}
          fallback={rows.map((row, index) => (
            <Text key={`qr-${index}`} color={TEXT_COLOR[row.available ? pctTone(row.pct) : 'muted']} wrap="truncate-end">
              {row.cli.padEnd(9)} {row.available ? `${bar((row.pct ?? 0) / 10)} ${row.pct ?? '?'}% ${row.window} ${row.reset}` : row.note}
            </Text>
          ))}
        />
      ) : null}
      {snapshot ? (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Pill ui={ui} key="primary" tone="info" label={`next worker: ${snapshot.primary || 'none'}`} />
          <Pill ui={ui} key="local" tone={snapshot.localLaborOk ? 'good' : 'warn'} label={snapshot.localLaborOk ? 'local labor ok' : 'local labor tight'} />
          <Pill ui={ui} key="checked" tone="muted" label={`checked ${ago(quota.lastOkAt, now)}`} />
        </Box>
      ) : null}
    </Card>
  )
}

function HookTable({ ui, rows, prefix }: { ui: Ui; rows: readonly HookRow[]; prefix: string }): RenderNode {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Box key={`${prefix}-${index}`} flexDirection="row" gap={1}>
          <Text dimColor>{clock(row.at)}</Text>
          <Text color={TEXT_COLOR[hookTone(row.outcome)]}>●</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {row.event}
              {row.tool ? ` · ${row.tool}` : ''}
              {row.detail ? `  ${row.detail}` : ''}
            </Text>
          </Box>
          {row.ms ? <Text dimColor>{row.ms} ms</Text> : null}
          <Text color={TEXT_COLOR[hookTone(row.outcome)]}>{row.outcome}</Text>
        </Box>
      ))}
    </Box>
  )
}

function HooksSection({ ui, data, actions }: { ui: Ui; data: CockpitData; actions: CockpitActions }): RenderNode {
  const { Box, Text } = ui
  const { hooks, now, width, open } = data
  const snapshot = hooks.data
  const liveRows = snapshot?.live ?? []
  const avg = liveRows.length ? Math.round(liveRows.reduce((sum, row) => sum + row.ms, 0) / liveRows.length) : 0
  const summary = `${snapshot?.inflight ?? 0} running · avg ${avg} ms`
  return (
    <Card ui={ui} sectionKey="hooks" title="Hooks" summary={summary} tone={hooksTone(hooks, now)} isOpen={open.hooks} onToggle={() => actions.toggle('hooks')}>
      <FeedNotice ui={ui} feed={hooks} now={now} />
      {snapshot?.lastBlock ? (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
          <Text color="red" bold>Last block · {ago(snapshot.lastBlock.at, now)}</Text>
          <Text wrap="wrap">
            {snapshot.lastBlock.source} {snapshot.lastBlock.event} {snapshot.lastBlock.tool} {snapshot.lastBlock.outcome} {snapshot.lastBlock.detail}
          </Text>
        </Box>
      ) : null}
      <Chart
        ui={ui}
        source={hooksChart(liveRows, width)}
        alt={`${liveRows.length} recent hook runs, average ${avg} ms`}
        width={width}
        fallback={<Text dimColor>{liveRows.length} hook runs · avg {avg} ms</Text>}
      />
      <Box flexDirection="column">
        <Label ui={ui}>Live</Label>
        {liveRows.length ? <HookTable ui={ui} rows={liveRows.slice(-6).reverse()} prefix="live" /> : <Caption ui={ui}>Waiting for the first hook run.</Caption>}
      </Box>
      <Box flexDirection="column">
        <Label ui={ui}>Gate and Jev log</Label>
        {(snapshot?.logs.length ?? 0) > 0 ? <HookTable ui={ui} rows={(snapshot?.logs ?? []).slice(-6).reverse()} prefix="log" /> : <Caption ui={ui}>No log rows yet.</Caption>}
      </Box>
    </Card>
  )
}

function RunRow({ ui, run, now, key }: { ui: Ui; run: SsaRun; now: number; key: string }): RenderNode {
  const { Box, Text } = ui
  const tone = runTone(run.state)
  return (
    <Box key={key} flexDirection="row" gap={1}>
      <Text color={TEXT_COLOR[tone]}>●</Text>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{run.type === 'plan' ? 'panel' : run.kind || 'task'}</Text>
          {` · ${run.worker || run.model || 'worker?'} · ${run.phase}`}
          {run.failureClass ? ` · ${run.failureClass}` : ''}
        </Text>
        <Text dimColor wrap="truncate-end">{run.id}</Text>
      </Box>
      <Text color={TEXT_COLOR[tone]}>{run.state === 'running' ? duration(now - run.startedAt) : ago(run.updatedAt, now)}</Text>
    </Box>
  )
}

function SubagentsSection({ ui, data, actions }: { ui: Ui; data: CockpitData; actions: CockpitActions }): RenderNode {
  const { Box, Text } = ui
  const { ssa, now, width, open } = data
  const running = ssa.data?.running ?? []
  const recent = ssa.data?.recent ?? []
  const summary = running.length ? `${running.length} running` : `${recent.length} recent`
  return (
    <Card ui={ui} sectionKey="subagents" title="Subagents" summary={summary} tone={ssaTone(ssa)} isOpen={open.subagents} onToggle={() => actions.toggle('subagents')}>
      <FeedNotice ui={ui} feed={ssa} now={now} />
      <Box flexDirection="column">
        <Label ui={ui}>Running now</Label>
        {running.length ? running.map((run, index) => <RunRow ui={ui} key={`run-${index}`} run={run} now={now} />) : <Caption ui={ui}>Nothing running.</Caption>}
      </Box>
      {recent.length ? (
        <Chart
          ui={ui}
          source={runStrip(recent, width)}
          alt={`${recent.length} recent runs`}
          width={width}
          fallback={<Text>{recent.slice(0, 30).reverse().map(run => (run.state === 'failed' ? '✗' : run.state === 'expired' ? '·' : '✓')).join('')}</Text>}
        />
      ) : null}
      <Box flexDirection="column">
        <Label ui={ui}>History</Label>
        {recent.length ? recent.slice(0, 8).map((run, index) => <RunRow ui={ui} key={`hist-${index}`} run={run} now={now} />) : <Caption ui={ui}>No runs recorded yet.</Caption>}
      </Box>
    </Card>
  )
}

export function Cockpit({ ui, data, actions }: { ui: Ui; data: CockpitData; actions: CockpitActions }): RenderElement {
  const { Box, Button, Text } = ui
  const sized: CockpitData = { ...data, width: chartWidth(data.width) }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text bold>Cockpit</Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{clock(data.now)}</Text>
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={actions.refresh} />
        </Box>
      </Box>
      <Overview ui={ui} data={sized} />
      <QuestioningSection ui={ui} data={sized} actions={actions} />
      <QuotaSection ui={ui} data={sized} actions={actions} />
      <HooksSection ui={ui} data={sized} actions={actions} />
      <SubagentsSection ui={ui} data={sized} actions={actions} />
    </Box>
  )
}

export function Band({ ui, data, actions }: { ui: Ui; data: CockpitData; actions: CockpitActions }): RenderElement | null {
  const { Box, Button, Text } = ui
  const { meter, quota, ssa, hooks, panel, now } = data
  const lowest = lowestWindow(quota.data)
  const running = ssa.data?.running ?? []
  const block = hooks.data?.lastBlock ?? null
  const showBlock = block !== null && now - block.at < 10 * 60 * 1000
  const showClarity = meter !== null && meter.status === 'interviewing'
  if (!showClarity && lowest === null && running.length === 0 && !showBlock && panel.phase !== 'countdown') return null
  const parts: RenderNode[] = []
  if (showClarity && meter) parts.push(<Text key="b-q" color={TEXT_COLOR[clarityTone(meter.clarity)]}>◆ {meter.clarity}/10 {trend(meter.history)}</Text>)
  if (panel.phase === 'countdown') parts.push(<Text key="b-p" color="yellow">⏱ panel in {Math.max(0, Math.ceil((panel.deadline - now) / 1000))}s</Text>)
  if (lowest) parts.push(<Text key="b-quota" color={TEXT_COLOR[pctTone(lowest.window.remainingPct)]}>▮ {lowest.cli} {lowest.window.remainingPct}%</Text>)
  if (running.length) parts.push(<Text key="b-ssa" color="cyan">⟳ {running.map(run => `${run.worker || run.kind} ${duration(now - run.startedAt)}`).join(', ')}</Text>)
  if (showBlock && block) parts.push(<Text key="b-block" color="red" wrap="truncate-end">⛔ {block.source} {block.outcome} {block.tool}</Text>)
  return (
    <Box flexDirection="row" gap={2} alignItems="center">
      {parts}
      <Button key="open" label="Cockpit" hotkey="c" plain onPress={actions.openPane} />
      <Button key="hide" label="Hide" hotkey="h" plain dimColor onPress={actions.hideBand} />
    </Box>
  )
}
