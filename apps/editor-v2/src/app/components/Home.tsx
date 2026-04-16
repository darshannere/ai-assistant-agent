import { readLocalStorageValue, useDisclosure, useViewportSize,  } from '@mantine/hooks';
import { Button, Title, Text, Stack, SimpleGrid, Dialog, TextInput, FileInput, Group, Image, Box } from "@mantine/core"
import { Link, useNavigate } from 'react-router-dom';
import { useState, useRef } from 'react';
import { BACKEND_URL } from '../config';

interface HomeProps {
  setValue: Function
}

export default function Home({setValue}: HomeProps) {
  const { height } = useViewportSize();
  const [opened, { toggle, close }] = useDisclosure(false);
  const [selected, setSelected] = useState("")
  const [name, setName] = useState("")
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [showWebcam, setShowWebcam] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const navigate = useNavigate()

  const handleSelected = (letter: string) => {
    setValue(letter)
    setSelected(letter)
    toggle()
    setTimeout(() => {
      close()
    }, 1500)
  }

  const handleFileChange = (file: File | null) => {
    setPhotoFile(file)
    if (file) {
      const reader = new FileReader()
      reader.onload = (e) => setPhotoPreview(e.target?.result as string)
      reader.readAsDataURL(file)
    } else {
      setPhotoPreview(null)
    }
  }

  const toggleWebcam = async () => {
    if (showWebcam) {
      // Stop webcam
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
        streamRef.current = null
      }
      setShowWebcam(false)
    } else {
      // Start webcam
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 1280, height: 720 } 
        })
        setShowWebcam(true)
        // Wait for next render to ensure video element exists
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            streamRef.current = stream
          }
        }, 100)
      } catch (err) {
        console.error('Error accessing webcam:', err)
        alert('Could not access webcam. Please check permissions.')
      }
    }
  }

  const capturePhoto = () => {
    if (videoRef.current && streamRef.current) {
      const canvas = document.createElement('canvas')
      canvas.width = videoRef.current.videoWidth
      canvas.height = videoRef.current.videoHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0)
        const photoData = canvas.toDataURL('image/jpeg', 0.8)
        setPhotoPreview(photoData)
        // Stop webcam after capture
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop())
          streamRef.current = null
        }
        setShowWebcam(false)
      }
    }
  }

  const handleGotoEditor = async () => {
    console.log('handleGotoEditor called', { selected, name, hasPhoto: !!photoPreview })
    if (selected && name && photoPreview) {
      const profile = {
        id: selected,
        name: name,
        photo: photoPreview,
        timestamp: Date.now()
      }
      console.log('Saving profile:', { id: selected, name, photoLength: photoPreview.length })
      
      // Save participant ID
      localStorage.setItem('participant-id', selected)
      setValue(selected)
      
      // Save to localStorage as backup
      localStorage.setItem(`participant_${selected}`, JSON.stringify(profile))
      
      // Save to backend
      try {
        const response = await fetch(`${BACKEND_URL}/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profile)
        })
        const result = await response.json()
        console.log('Profile save response:', result)
        if (result.status === 'success') {
          console.log('✅ Profile saved successfully!')
        }
      } catch (error) {
        console.error('❌ Failed to save profile:', error)
        alert('Failed to save profile to backend: ' + error)
      }
    } else {
      console.log('❌ Form not valid:', { selected, name, hasPhoto: !!photoPreview })
      alert('Please fill all fields: participant, name, and photo')
    }
  }

  const isFormValid = selected && name && photoPreview

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 40 }}>
      <Stack align="center" justify="center" py="xl">
        <Stack align="start" maw={500}>
          <Title order={1}>Welcome To The Study</Title>
          <Text size="lg">Which user are you?</Text>
          <SimpleGrid w="100%">
            <Button onClick={() => handleSelected('A')} variant={selected === 'A' ? "light" :"default"}>A</Button>
            <Button onClick={() => handleSelected('B')} variant={selected === 'B' ? "light" :"default"}>B</Button>
            <Button onClick={() => handleSelected('C')} variant={selected === 'C' ? "light" :"default"}>C</Button>
          </SimpleGrid>

          {selected && selected !== 'O' && (
            <Box w="100%" mt="md">
              <TextInput
                label="Your Name"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                mb="md"
              />
              
              <Text size="sm" fw={500} mb="xs">Photo (upload or webcam)</Text>
              <Group mb="sm">
                <FileInput
                  placeholder="Choose file"
                  accept="image/*"
                  value={photoFile}
                  onChange={handleFileChange}
                  variant="filled"
                  color="gray"
                />
                <Button onClick={toggleWebcam} variant="light">
                  {showWebcam ? 'Cancel Webcam' : 'Use Webcam'}
                </Button>
              </Group>

              {showWebcam && (
                <Box mb="md" style={{ border: '2px solid #ddd', borderRadius: 8, padding: 10 }}>
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    muted 
                    style={{ 
                      width: '100%', 
                      maxWidth: 400, 
                      borderRadius: 8,
                      backgroundColor: '#000'
                    }} 
                  />
                  <Button onClick={capturePhoto} fullWidth mt="xs" color="blue">
                    Capture Photo
                  </Button>
                </Box>
              )}

              {photoPreview && (
                <Box mb="md">
                  <Text size="sm" mb="xs">Preview:</Text>
                  <Image src={photoPreview} alt="Preview" w={100} h={100} radius="md" fit="cover" />
                </Box>
              )}
            </Box>
          )}

          <Button 
            mt={10} 
            disabled={!isFormValid} 
            onClick={async () => {
              await handleGotoEditor();
              navigate('/editor');
            }}
          >
            Goto Editor
          </Button>
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
