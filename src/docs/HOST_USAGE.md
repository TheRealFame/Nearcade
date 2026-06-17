# Host Usage and Dashboard Guide

The Host Dashboard is your control center for managing streams, viewers, and system audio.

## Video and Audio Capture
When you start a session, Nearsec connects to your native operating system APIs like Wayland, X11, or Windows Graphics Capture.
* Audio Routing for Linux: Nearsec automatically creates a NearsecVirtualCapture virtual sink. The system uses exact PipeWire node properties to route game audio into this sink automatically. This keeps your personal desktop audio and voice chats off the stream.
* Volume Control: The virtual sink caps at 70 percent volume automatically to protect your hearing.

## Player Roster and Input Permissions
Viewers appear in the Roster as they join. You have complete control over their input modes.
* Gamepad: Creates a native virtual controller.
* Raw Keyboard and Mouse: Direct input passthrough.
* Emulated Keyboard and Mouse: Maps keyboard inputs to a virtual gamepad. This helps when retro or fighting games lack native keyboard support.
* Lock Slots: Click the padlock icon to prevent random viewers from taking over an active player slot.

## Voice Chat Management
Viewers can send their microphone audio directly to the Host.
* Red Mic Icon: Locally muted. You will not hear them but their audio is still arriving at the server.
* Grey Mic Icon: Force muted. The server drops their audio packets entirely to save bandwidth for all users.

This project uses artificial intelligence large language models for code generation and structure planning.
