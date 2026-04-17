import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
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
  concepts: string[];
};

type DebugStateResponse = {
  participantStates: Record<string, ParticipantState>;
  accumulatedConcepts: Record<string, string[]>;
  activeProfiles: Record<string, string>;
};

export default function ConceptDashboard() {
  const [participantStates, setParticipantStates] = useState<Record<string, ParticipantState>>({});
  const [accumulatedConcepts, setAccumulatedConcepts] = useState<Record<string, string[]>>({});
  const [activeProfiles, setActiveProfiles] = useState<Record<string, string>>({});
  const [functionConcepts, setFunctionConcepts] = useState<FunctionConcept[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchDashboardData = useCallback(async () => {
    const [debugResponse, conceptMapResponse] = await Promise.all([
      fetch(`${BACKEND_URL}/debug/states`),
      fetch(`${BACKEND_URL}/concept-map`),
    ]);

    const debugData: DebugStateResponse = await debugResponse.json();
    const conceptMapData = await conceptMapResponse.json();

    setParticipantStates(debugData.participantStates || {});
    setAccumulatedConcepts(debugData.accumulatedConcepts || {});
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
                      <Badge key={concept} color="teal" variant="light">
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
                        <Badge key={concept} variant="light" color="grape">
                          {concept}
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
    </Stack>
  );
}
