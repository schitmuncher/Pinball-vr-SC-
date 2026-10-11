// Minimal SDL2 surface for the Space Cadet engine running inside a browser (WebXR) host.
// Only what the engine touches is declared; everything is implemented in platform.cpp.
#pragma once
#include <cstdint>
#include <cstddef>

typedef uint8_t Uint8;
typedef uint16_t Uint16;
typedef uint32_t Uint32;
typedef int32_t Sint32;
typedef uint64_t Uint64;
typedef int32_t SDL_Keycode;
typedef enum { SDL_FALSE = 0, SDL_TRUE = 1 } SDL_bool;

#define SDL_VERSION_ATLEAST(a, b, c) 1
#define SDL_INIT_EVERYTHING 0xFFFF
#define SDL_WINDOWPOS_UNDEFINED 0
#define SDL_WINDOW_HIDDEN 0x8
#define SDL_WINDOW_RESIZABLE 0x20
#define SDL_WINDOW_FULLSCREEN_DESKTOP 0x1001
#define SDL_RENDERER_ACCELERATED 0x2
#define SDL_PIXELFORMAT_ARGB8888 0x16362004
#define SDL_TEXTUREACCESS_STATIC 0
#define SDL_TEXTUREACCESS_STREAMING 1
#define SDL_BLENDMODE_NONE 0
#define SDL_HINT_RENDER_SCALE_QUALITY "SDL_RENDER_SCALE_QUALITY"
#define SDL_MESSAGEBOX_WARNING 0x20

#define SDL_BUTTON_LEFT 1
#define SDL_BUTTON_MIDDLE 2
#define SDL_BUTTON_RIGHT 3
#define SDL_BUTTON_X1 4
#define SDL_BUTTON_X2 5

#define SDLK_SCANCODE_MASK (1 << 30)
#define SDL_SCANCODE_TO_KEYCODE(X) ((X) | SDLK_SCANCODE_MASK)
enum
{
	SDLK_ESCAPE = 27, SDLK_SPACE = ' ', SDLK_PERIOD = '.', SDLK_SLASH = '/',
	SDLK_g = 'g', SDLK_x = 'x', SDLK_y = 'y', SDLK_z = 'z',
	SDLK_F1 = SDL_SCANCODE_TO_KEYCODE(58), SDLK_F2, SDLK_F3, SDLK_F4, SDLK_F5, SDLK_F6,
	SDLK_F7, SDLK_F8, SDLK_F9, SDLK_F10, SDLK_F11, SDLK_F12,
	SDLK_UP = SDL_SCANCODE_TO_KEYCODE(82),
};

typedef enum
{
	SDL_CONTROLLER_BUTTON_INVALID = -1,
	SDL_CONTROLLER_BUTTON_A, SDL_CONTROLLER_BUTTON_B, SDL_CONTROLLER_BUTTON_X, SDL_CONTROLLER_BUTTON_Y,
	SDL_CONTROLLER_BUTTON_BACK, SDL_CONTROLLER_BUTTON_GUIDE, SDL_CONTROLLER_BUTTON_START,
	SDL_CONTROLLER_BUTTON_LEFTSTICK, SDL_CONTROLLER_BUTTON_RIGHTSTICK,
	SDL_CONTROLLER_BUTTON_LEFTSHOULDER, SDL_CONTROLLER_BUTTON_RIGHTSHOULDER,
	SDL_CONTROLLER_BUTTON_DPAD_UP, SDL_CONTROLLER_BUTTON_DPAD_DOWN,
	SDL_CONTROLLER_BUTTON_DPAD_LEFT, SDL_CONTROLLER_BUTTON_DPAD_RIGHT,
} SDL_GameControllerButton;

struct SDL_Window;
struct SDL_Renderer;
struct SDL_Texture;
struct SDL_RWops;
struct SDL_GameController;

struct SDL_Rect { int x, y, w, h; };
struct SDL_FRect { float x, y, w, h; };

enum
{
	SDL_QUIT = 0x100, SDL_WINDOWEVENT = 0x200, SDL_KEYDOWN = 0x300, SDL_KEYUP,
	SDL_MOUSEBUTTONDOWN = 0x401, SDL_MOUSEBUTTONUP,
	SDL_JOYDEVICEADDED = 0x605, SDL_JOYDEVICEREMOVED,
	SDL_CONTROLLERBUTTONDOWN = 0x651, SDL_CONTROLLERBUTTONUP,
};

struct SDL_Event
{
	Uint32 type;
};

inline const char* SDL_GetError() { return ""; }
inline void SDL_ClearError() {}
inline int SDL_ShowSimpleMessageBox(Uint32, const char*, const char*, SDL_Window*) { return 0; }
inline SDL_bool SDL_SetHint(const char*, const char*) { return SDL_TRUE; }
inline const char* SDL_GetHint(const char*) { return nullptr; }
inline int SDL_SetWindowFullscreen(SDL_Window*, Uint32) { return 0; }
void SDL_GetRendererOutputSize(SDL_Renderer*, int* w, int* h);
SDL_Texture* SDL_CreateTexture(SDL_Renderer*, Uint32, int, int, int);
inline void SDL_DestroyTexture(SDL_Texture*) {}
inline int SDL_UpdateTexture(SDL_Texture*, const SDL_Rect*, const void*, int) { return 0; }
int SDL_LockTexture(SDL_Texture*, const SDL_Rect*, void** pixels, int* pitch);
inline void SDL_UnlockTexture(SDL_Texture*) {}
inline int SDL_SetTextureBlendMode(SDL_Texture*, int) { return 0; }
inline int SDL_RenderCopy(SDL_Renderer*, SDL_Texture*, const SDL_Rect*, const SDL_Rect*) { return 0; }
inline int SDL_RenderCopyF(SDL_Renderer*, SDL_Texture*, const SDL_Rect*, const SDL_FRect*) { return 0; }
SDL_RWops* SDL_RWFromMem(void* mem, int size);
Uint32 SDL_GetTicks();
Uint64 SDL_GetPerformanceCounter();
Uint64 SDL_GetPerformanceFrequency();
