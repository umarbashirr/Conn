/* The Agents tab: the active chat's subagents, and what the chosen one did.

   The list is on top and the transcript fills the rest, the same split as the
   Changes view. With nothing chosen the newest agent shows, since it is the
   one most likely still going.

   A finished agent's transcript stays for as long as the chat does. Reading
   what an agent did after it failed is most of the reason to open one. */
import { useSyncExternalStore } from 'react';
import { BotIcon } from 'lucide-react';

import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { AgentActions, AgentMeta } from '@/components/agent-row';
import { SubagentGlyph } from '@/components/subagent-glyph';
import { SubagentStream, useSubagentTranscript } from '@/components/subagent-stream';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { activityOf, isLive, nameOf, statusOf } from '@/lib/subagents';
import { cn } from '@/lib/utils';
import { Items } from '../App';
import { onProject, project } from '../../project.js';
import { agentsState, getAgentsVersion, selectAgent, subscribeAgents } from './agents-store';
import { useLayout } from './Shell';
import { activeKind, subscribeTabs } from './tabs-store';

// Whether this tab is the one on screen, asked the way FilesView asks.
const subscribeTop = (fn) => {
  const offTabs = subscribeTabs(fn);
  const offFocus = onProject(fn);
  return () => { offTabs(); offFocus(); };
};
const onTop = () => activeKind(project.focused) === 'agents';

function AgentList({ agents, current }) {
  return (
    <div className="max-h-[35%] shrink-0 overflow-y-auto border-b p-1.5">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => selectAgent(a.id)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-secondary/60',
            a.id === current?.id && 'bg-secondary',
          )}>
          <SubagentGlyph item={a} />
          <span className={cn('min-w-0 flex-1 truncate', statusOf(a) === 'error' && 'text-destructive')}>
            {nameOf(a)}
          </span>
          <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground/75">
            <AgentMeta item={a} />
          </span>
        </button>
      ))}
    </div>
  );
}

function AgentDetail({ item, agent }) {
  const under = activityOf(item);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <SubagentGlyph item={item} className="mt-[3px]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px]">{nameOf(item)}</span>
            <span className="shrink-0 text-muted-foreground text-xs">{item.agentType || 'agent'}</span>
          </span>
          {under && (
            <span className="truncate text-muted-foreground text-xs">
              {isLive(item) ? <Shimmer as="span">{under}</Shimmer> : under}
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground/75">
          <AgentActions item={item} onStop={agent.stopAgent} onBackground={agent.backgroundAgent} />
        </span>
      </div>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-3 p-3">
          <SubagentStream item={item} agent={agent} Items={Items} />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}

export default function AgentsView() {
  useSyncExternalStore(subscribeAgents, getAgentsVersion, getAgentsVersion);
  const { rightOpen } = useLayout();
  const top = useSyncExternalStore(subscribeTop, onTop, onTop);
  const showing = rightOpen && top;

  const { agent, agents, selected } = agentsState();
  const current = agents.find((a) => a.id === selected) || agents[agents.length - 1] || null;
  useSubagentTranscript(agent, current, showing);

  return (
    <div id="agents-view" className="flex h-full min-h-0 flex-col" hidden={!showing || undefined}>
      {current ? (
        <>
          <AgentList agents={agents} current={current} />
          {/* Keyed, so switching agents starts the next one scrolled to its end
              rather than wherever the last one was left. */}
          <AgentDetail key={current.id} item={current} agent={agent} />
        </>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
            <EmptyTitle>No agents in this chat</EmptyTitle>
            <EmptyDescription>When the agent hands work to a subagent, it shows up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
