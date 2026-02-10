import { readLocalStorageValue, useDisclosure, useViewportSize,  } from '@mantine/hooks';
import { Button, Title, Text, Stack, SimpleGrid, Dialog } from "@mantine/core"
import { Link } from 'react-router-dom';
import { useState } from 'react';

interface HomeProps {
  setValue: Function
}

export default function Home({setValue}: HomeProps) {
  const { height } = useViewportSize();
  const [opened, { toggle, close }] = useDisclosure(false);
  const [selected, setSelected] = useState("")

  const handleSelected = (letter: string) => {
    setValue(letter)
    setSelected(letter)
    toggle()
    setTimeout(() => {
      close()
    }, 1500)
  }

  return (
    <div>
      <Stack align="center" justify="center" h={height/2}>
        <Stack align="start">
          <Title order={1}>Welcome To The Study</Title>
          <Text size="lg">Which user are you?</Text>
          <SimpleGrid w="100%">
            <Button onClick={() => handleSelected('A')} variant={selected === 'A' ? "light" :"default"}>A</Button>
            <Button onClick={() => handleSelected('B')} variant={selected === 'B' ? "light" :"default"}>B</Button>
            <Button onClick={() => handleSelected('C')} variant={selected === 'C' ? "light" :"default"}>C</Button>
          </SimpleGrid>
          {/* TODO: Add protected route clause */}
          <Link to="/editor">
            <Button mt={10}>Goto Editor</Button>
            
          </Link>
          <Link to="/draw" state={{id:selected}}>
            <Button mt={10}>Goto Draw</Button>
          </Link>
        </Stack>
      </Stack>

      <Dialog opened={opened} onClose={close} size="lg" radius="md">
        <Text size="sm" mb="xs" fw={500}>
          Participant {selected} selected
        </Text>
      </Dialog>
    </div>
  )
}
