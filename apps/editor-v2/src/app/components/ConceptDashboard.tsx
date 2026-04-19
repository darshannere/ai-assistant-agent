import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Code, Group, Modal, ScrollArea, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
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
  const [selectedReferenceConcept, setSelectedReferenceConcept] = useState<{
    functionName: string;
    concept: string;
    solutionReference: string;
  } | null>(null);
  const [manualEditTarget, setManualEditTarget] = useState<{
    participantId: string;
    participantName: string;
    concept: string;
    entry: ConceptEvidence;
  } | null>(null);
  const [teamEditorCode, setTeamEditorCode] = useState('');
  const [selectedLineStart, setSelectedLineStart] = useState<number | null>(null);
  const [selectedLineEnd, setSelectedLineEnd] = useState<number | null>(null);
  const [savingManualEdit, setSavingManualEdit] = useState(false);
  const [clearingParticipants, setClearingParticipants] = useState(false);

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
    return { debugData, conceptMapData };
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

  const openManualEdit = useCallback(async (
    participantId: string,
    participantName: string,
    concept: string,
    entry: ConceptEvidence
  ) => {
    const response = await fetch(`${BACKEND_URL}/team-editor-code`);
    const data = await response.json();
    setTeamEditorCode(data.code || '');
    setSelectedLineStart(entry.line_start);
    setSelectedLineEnd(entry.line_end);
    setManualEditTarget({ participantId, participantName, concept, entry });
  }, []);

  const handleTeamLineClick = (lineNumber: number) => {
    if (selectedLineStart === null || (selectedLineStart !== null && selectedLineEnd !== null)) {
      setSelectedLineStart(lineNumber);
      setSelectedLineEnd(null);
      return;
    }

    if (selectedLineStart !== null && selectedLineEnd === null) {
      if (lineNumber < selectedLineStart) {
        setSelectedLineEnd(selectedLineStart);
        setSelectedLineStart(lineNumber);
      } else {
        setSelectedLineEnd(lineNumber);
      }
    }
  };

  const handleClearParticipants = useCallback(async () => {
    const ok = window.confirm(
      'Clear ALL participants from backend memory?\n\nThis wipes profiles, concepts, evidence, help queue, and cursors. Cannot be undone.'
    );
    if (!ok) return;
    setClearingParticipants(true);
    try {
      const response = await fetch(`${BACKEND_URL}/debug/clear-participants`, { method: 'POST' });
      if (!response.ok) throw new Error(`Clear failed: ${response.status}`);
      await fetchDashboardData();
    } catch (error) {
      console.error('Failed to clear participants:', error);
      window.alert('Failed to clear participants — see console for details.');
    } finally {
      setClearingParticipants(false);
    }
  }, [fetchDashboardData]);

  const handleSaveManualEdit = useCallback(async () => {
    if (!manualEditTarget || selectedLineStart === null) return;
    const finalEnd = selectedLineEnd ?? selectedLineStart;
    setSavingManualEdit(true);
    try {
      await fetch(`${BACKEND_URL}/concept-evidence/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: manualEditTarget.participantId,
          concept: manualEditTarget.concept,
          function: manualEditTarget.entry.function,
          lineStart: selectedLineStart,
          lineEnd: finalEnd,
          source: 'team',
        }),
      });
      const refreshed = await fetchDashboardData();
      setSelectedConcept((prev) => prev ? {
        ...prev,
        evidence: refreshed?.debugData?.conceptEvidence?.[manualEditTarget.participantId]?.[manualEditTarget.concept] || prev.evidence,
      } : prev);
      setManualEditTarget(null);
    } catch (error) {
      console.error('Failed to save manual concept evidence:', error);
    } finally {
      setSavingManualEdit(false);
    }
  }, [manualEditTarget, selectedLineStart, selectedLineEnd, fetchDashboardData]);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="end">
        <div>
          <Title order={2}>Concept Dashboard</Title>
          <Text size="sm" c="dimmed">
            Research and debugging view for participant cognition, current work state, and evolving concept maps.
          </Text>
        </div>
        <Group gap="sm" align="center">
          <Text size="sm" c="dimmed">
            {lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}` : 'Loading...'}
          </Text>
          <Button
            color="red"
            variant="light"
            size="xs"
            loading={clearingParticipants}
            onClick={handleClearParticipants}
          >
            Clear All Participants
          </Button>
        </Group>
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
                        <Badge
                          key={concept.name}
                          variant="light"
                          color="grape"
                          style={{ cursor: 'pointer' }}
                          onClick={() => setSelectedReferenceConcept({
                            functionName: fn.name,
                            concept: concept.name,
                            solutionReference: concept.solution_reference,
                          })}
                        >
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
                  <Group justify="end">
                    <Button
                      size="compact-xs"
                      variant="light"
                      onClick={() => {
                        void openManualEdit(
                          selectedConcept.participantId,
                          selectedConcept.participantName,
                          selectedConcept.concept,
                          entry
                        );
                      }}
                    >
                      Edit From Team Editor
                    </Button>
                  </Group>
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

      <Modal
        opened={selectedReferenceConcept !== null}
        onClose={() => setSelectedReferenceConcept(null)}
        title={selectedReferenceConcept ? `${selectedReferenceConcept.functionName} · ${selectedReferenceConcept.concept}` : ''}
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Reference solution snippet for this concept in the canonical solution mapping.
          </Text>
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {selectedReferenceConcept?.solutionReference || 'No predefined reference snippet available.'}
          </Code>
        </Stack>
      </Modal>

      <Modal
        opened={manualEditTarget !== null}
        onClose={() => setManualEditTarget(null)}
        title={
          manualEditTarget ? `${manualEditTarget.entry.function} · ${manualEditTarget.concept}` : ''
        }
        size="xl"
      >
        {manualEditTarget && (
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Click a start line and then an end line from the live Team Editor snapshot to replace the observed implementation evidence.
            </Text>
            <ScrollArea h={420} type="always">
              <Stack gap={0}>
                {teamEditorCode.split('\n').map((line, index) => {
                  const lineNumber = index + 1;
                  const start = selectedLineStart ?? lineNumber;
                  const end = selectedLineEnd ?? selectedLineStart ?? lineNumber;
                  const isSelected = selectedLineStart !== null && lineNumber >= Math.min(start, end) && lineNumber <= Math.max(start, end);
                  return (
                    <div
                      key={lineNumber}
                      onClick={() => handleTeamLineClick(lineNumber)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '56px 1fr',
                        gap: 12,
                        padding: '4px 8px',
                        cursor: 'pointer',
                        background: isSelected ? '#e0f2fe' : 'transparent',
                        borderRadius: 6,
                        fontFamily: 'monospace',
                        fontSize: 13,
                      }}
                    >
                      <Text size="xs" c="dimmed" ta="right">{lineNumber}</Text>
                      <Code style={{ whiteSpace: 'pre-wrap', background: 'transparent', padding: 0 }}>
                        {line || ' '}
                      </Code>
                    </div>
                  );
                })}
              </Stack>
            </ScrollArea>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {selectedLineStart !== null
                  ? `Selected lines ${selectedLineStart}-${selectedLineEnd ?? selectedLineStart}`
                  : 'No lines selected yet.'}
              </Text>
              <Group>
                <Button variant="default" onClick={() => {
                  setSelectedLineStart(null);
                  setSelectedLineEnd(null);
                }}>
                  Reset Selection
                </Button>
                <Button onClick={() => { void handleSaveManualEdit(); }} loading={savingManualEdit} disabled={selectedLineStart === null}>
                  Save Selection
                </Button>
              </Group>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
