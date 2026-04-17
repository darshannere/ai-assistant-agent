import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Code, Group, Modal, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { BACKEND_URL } from '../config';
import ParticipantLabel from './ParticipantLabel';

type ParticipantState = {
  status: string;
  currentTasks: string[];
  name: string;
  photo: string | null;
  concepts: string[];
};

type FunctionConcept = {
  name: string;
  description: string;
  concepts: Array<{
    name: string;
    solution_reference: string;
  }>;
};

type ConceptEvidence = {
  function: string;
  code: string;
  line_start: number;
  line_end: number;
  source: string;
  updated_at: number;
  implemented_by: string;
  solution_reference: string;
};

type DebugStateResponse = {
  participantStates: Record<string, ParticipantState>;
  accumulatedConcepts: Record<string, string[]>;
  conceptEvidence: Record<string, Record<string, ConceptEvidence[]>>;
  activeProfiles: Record<string, string>;
};

export default function ConceptDashboard() {
  const [participantStates, setParticipantStates] = useState<Record<string, ParticipantState>>({});
  const [accumulatedConcepts, setAccumulatedConcepts] = useState<Record<string, string[]>>({});
  const [conceptEvidence, setConceptEvidence] = useState<Record<string, Record<string, ConceptEvidence[]>>>({});
  const [activeProfiles, setActiveProfiles] = useState<Record<string, string>>({});
  const [functionConcepts, setFunctionConcepts] = useState<FunctionConcept[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedConcept, setSelectedConcept] = useState<{
    participantId: string;
    participantName: string;
    concept: string;
    evidence: ConceptEvidence[];
  } | null>(null);

  const fetchDashboardData = useCallback(async () => {
    const [debugResponse, conceptMapResponse] = await Promise.all([
      fetch(`${BACKEND_URL}/debug/states`),
      fetch(`${BACKEND_URL}/concept-map`),
    ]);

    const debugData: DebugStateResponse = await debugResponse.json();
    const conceptMapData = await conceptMapResponse.json();

    setParticipantStates(debugData.participantStates || {});
    setAccumulatedConcepts(debugData.accumulatedConcepts || {});
    setConceptEvidence(debugData.conceptEvidence || {});
    setActiveProfiles(debugData.activeProfiles || {});
    setFunctionConcepts(conceptMapData.functions || []);
    setLastUpdated(new Date());
  }, []);

  useEffect(() => {
    fetchDashboardData().catch((error) => {
      console.error('Failed to fetch concept dashboard data:', error);
    });
    const interval = setInterval(() => {
      fetchDashboardData().catch((error) => {
        console.error('Failed to refresh concept dashboard data:', error);
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  const participantIds = Object.keys({
    ...participantStates,
    ...accumulatedConcepts,
    ...activeProfiles,
  }).sort();

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="end">
        <div>
          <Title order={2}>Concept Dashboard</Title>
          <Text size="sm" c="dimmed">
            Research and debugging view for participant cognition, current work state, and evolving concept maps.
          </Text>
        </div>
        <Text size="sm" c="dimmed">
          {lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}` : 'Loading...'}
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        {participantIds.map((participantId) => {
          const state = participantStates[participantId];
          const concepts = accumulatedConcepts[participantId] || state?.concepts || [];
          const currentTask = activeProfiles[participantId] || state?.currentTasks?.join(', ') || 'Idle';
          const statusColor = state?.status === 'unavailable' ? 'orange' : 'green';

          return (
            <Card key={participantId} withBorder radius="md" shadow="sm" padding="lg">
              <Stack gap="sm">
                <Group justify="space-between" align="start">
                  <ParticipantLabel
                    id={participantId}
                    name={state?.name || participantId}
                    photo={state?.photo || null}
                    avatarSize={28}
                    textSize={18}
                  />
                  <Badge color={statusColor} variant="light">
                    {state?.status || 'unknown'}
                  </Badge>
                </Group>

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed">Current Focus</Text>
                  <Text size="sm">{currentTask || 'Idle'}</Text>
                </div>

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed">Current Tasks</Text>
                  <Group gap={6} mt={4}>
                    {(state?.currentTasks?.length ? state.currentTasks : ['None']).map((task) => (
                      <Badge key={task} variant="dot" color="blue">
                        {task}
                      </Badge>
                    ))}
                  </Group>
                </div>

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed">Accumulated Concepts</Text>
                    <Group gap={6} mt={4}>
                      {concepts.length > 0 ? concepts.map((concept) => (
                      <Badge
                        key={concept}
                        color="teal"
                        variant="light"
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          setSelectedConcept({
                            participantId,
                            participantName: state?.name || participantId,
                            concept,
                            evidence: conceptEvidence[participantId]?.[concept] || [],
                          });
                        }}
                      >
                        {concept}
                      </Badge>
                    )) : (
                      <Text size="sm" c="dimmed">No concepts recorded yet.</Text>
                    )}
                  </Group>
                </div>
              </Stack>
            </Card>
          );
        })}
      </SimpleGrid>

      <Card withBorder radius="md" shadow="sm" padding="lg">
        <Stack gap="sm">
          <div>
            <Title order={3}>Function Concept Map</Title>
            <Text size="sm" c="dimmed">
              Reference map of which concepts each study-problem function is meant to exercise.
            </Text>
          </div>

          <Table striped highlightOnHover withTableBorder withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Function</Table.Th>
                <Table.Th>Concepts</Table.Th>
                <Table.Th>Description</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {functionConcepts.map((fn) => (
                <Table.Tr key={fn.name}>
                  <Table.Td>
                    <Text fw={700} ff="monospace">{fn.name}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6}>
                      {fn.concepts.map((concept) => (
                        <Badge key={concept.name} variant="light" color="grape">
                          {concept.name}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{fn.description}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      </Card>

      <Modal
        opened={selectedConcept !== null}
        onClose={() => setSelectedConcept(null)}
        title={
          selectedConcept ? (
            <Group gap="xs">
              <ParticipantLabel
                id={selectedConcept.participantId}
                name={selectedConcept.participantName}
                avatarSize={20}
                textSize={16}
              />
              <Text fw={700}>· {selectedConcept.concept}</Text>
            </Group>
          ) : null
        }
        size="xl"
      >
        {selectedConcept && (
          <Stack gap="md">
            {selectedConcept.evidence.length > 0 ? selectedConcept.evidence.map((entry, index) => (
              <Card key={`${entry.function}-${index}`} withBorder radius="md" padding="md">
                <Stack gap="xs">
                  <Group justify="space-between">
                    <Text fw={700} ff="monospace">{entry.function}</Text>
                    <Badge variant="light">{entry.source}</Badge>
                  </Group>
                  <Text size="sm" c="dimmed">
                    Lines {entry.line_start}-{entry.line_end} in the inferred implementation snippet.
                  </Text>
                  <div>
                    <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>Observed Implementation</Text>
                    <Code block style={{ whiteSpace: 'pre-wrap' }}>
                      {entry.code}
                    </Code>
                  </div>
                  <div>
                    <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>Solution Reference Context</Text>
                    <Code block style={{ whiteSpace: 'pre-wrap' }}>
                      {entry.solution_reference || 'No predefined reference snippet available.'}
                    </Code>
                  </div>
                  <Text size="xs" c="dimmed">
                    Updated {new Date(entry.updated_at * 1000).toLocaleString()}
                  </Text>
                </Stack>
              </Card>
            )) : (
              <Text size="sm" c="dimmed">
                No implementation evidence has been inferred for this concept yet.
              </Text>
            )}
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
