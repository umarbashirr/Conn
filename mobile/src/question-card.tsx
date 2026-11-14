import { useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { OTHER, replyOf, type Question, type Reply } from '../../src/shared/ask-answers.js';
import { layout, zinc, themed } from './theme/zinc';

function chosenLabels(pick: string | string[] | undefined): readonly string[] {
  if (typeof pick === 'string') return [pick];
  if (Array.isArray(pick)) return pick;
  return [];
}

export function QuestionCard(props: {
  readonly questions: readonly Question[];
  readonly onAnswer: (reply: Reply) => void;
  readonly onSkip: () => void;
}): ReactElement {
  const { questions, onAnswer, onSkip } = props;
  const [picked, setPicked] = useState<Record<string, string | string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const reply = replyOf(questions, picked, typed);

  function choose(question: Question, label: string): void {
    setPicked((cur) => {
      if (!question.multiSelect) return { ...cur, [question.question]: label };
      const had = chosenLabels(cur[question.question]);
      const next = had.includes(label) ? had.filter((value) => value !== label) : [...had, label];
      return { ...cur, [question.question]: next };
    });
  }

  return (
    <View style={styles.card}>
      {questions.map((question) => {
        const chosen = chosenLabels(picked[question.question]);
        const options = [
          ...question.options.map((option) => ({ label: option.label, value: option.label, description: option.description })),
          { label: 'Other', value: OTHER, description: 'Answer in your own words' },
        ];
        return (
          <View key={question.question} style={styles.question}>
            {question.header ? <Text style={styles.header}>{question.header}</Text> : null}
            <Text style={styles.prompt}>{question.question}</Text>
            {options.map((option) => {
              const on = chosen.includes(option.value);
              return (
                <Pressable
                  key={option.value}
                  onPress={() => choose(question, option.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={option.label}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {option.description ? <Text style={styles.optionNote}>{option.description}</Text> : null}
                </Pressable>
              );
            })}
            {chosen.includes(OTHER) ? (
              <TextInput
                value={typed[question.question] ?? ''}
                onChangeText={(text) => setTyped((cur) => ({ ...cur, [question.question]: text }))}
                placeholder="Your answer"
                placeholderTextColor={zinc.faint}
                accessibilityLabel={`Other answer for ${question.question}`}
                style={styles.other}
              />
            ) : null}
          </View>
        );
      })}
      <View style={styles.actions}>
        <Pressable
          onPress={() => onAnswer(reply)}
          disabled={!reply.complete}
          accessibilityRole="button"
          accessibilityLabel="Send answers"
          accessibilityState={{ disabled: !reply.complete }}
        >
          <Text style={[styles.action, !reply.complete && styles.actionOff]}>Send answers</Text>
        </Pressable>
        <Pressable onPress={onSkip} accessibilityRole="button" accessibilityLabel="Skip">
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  card: {
    backgroundColor: zinc.waitingFill,
    borderColor: zinc.waitingBorder,
    borderWidth: 1,
    borderRadius: layout.bubble,
    paddingHorizontal: layout.bubbleX,
    paddingVertical: layout.bubbleY,
    gap: 12,
  },
  question: {
    gap: 6,
  },
  header: {
    color: zinc.waiting,
    fontSize: 12.5,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  prompt: {
    color: zinc.text,
    fontSize: 16,
    lineHeight: 22,
  },
  option: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  optionOn: {
    backgroundColor: zinc.secondary,
  },
  optionLabel: {
    color: zinc.text,
    fontSize: 15,
    lineHeight: 20,
  },
  optionNote: {
    color: zinc.faint,
    fontSize: 13,
    lineHeight: 18,
  },
  other: {
    color: zinc.text,
    fontSize: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: zinc.border,
    paddingVertical: 8,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    minHeight: 44,
  },
  action: {
    color: zinc.text,
    fontSize: 15,
    fontWeight: '600',
  },
  actionOff: {
    color: zinc.faint,
  },
  skip: {
    color: zinc.muted,
    fontSize: 15,
  },
}));
