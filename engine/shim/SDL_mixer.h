// Minimal SDL_mixer surface: sounds and music are handed to the browser's Web Audio via imports.
#pragma once
#include "SDL.h"

#define SDL_MIXER_PATCHLEVEL 4
#define MIX_INIT_MID 0x20
#define MIX_DEFAULT_FREQUENCY 44100
#define MIX_DEFAULT_FORMAT 0x8010
#define MIX_MAX_VOLUME 128

struct Mix_Chunk { int id; };
struct Mix_Music { int id; };

int Mix_Init(int flags);
inline void Mix_Quit() {}
inline int Mix_OpenAudio(int, Uint16, int, int) { return 0; }
inline void Mix_CloseAudio() {}
inline int Mix_AllocateChannels(int n) { return n; }
int Mix_Volume(int channel, int volume);
int Mix_VolumeMusic(int volume);
int Mix_HaltChannel(int channel);
inline void Mix_Resume(int) {}
inline void Mix_Pause(int) {}
inline int Mix_Playing(int) { return 0; }
int Mix_PlayChannel(int channel, Mix_Chunk* chunk, int loops);
Mix_Chunk* Mix_LoadWAV(const char* file);
void Mix_FreeChunk(Mix_Chunk* chunk);
Mix_Music* Mix_LoadMUS(const char* file);
Mix_Music* Mix_LoadMUS_RW(SDL_RWops* src, int freesrc);
void Mix_FreeMusic(Mix_Music* music);
int Mix_PlayMusic(Mix_Music* music, int loops);
int Mix_HaltMusic();
