#include <openvr_driver.h>
#include <thread>
#include <atomic>
#include <vector>
#include <cstring>
#include <iostream>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#endif

using namespace vr;

// Binary packet structure matching backend_vr.py
#pragma pack(push, 1)
struct NearsecVRPacket {
    uint32_t seq;
    float head_qx, head_qy, head_qz, head_qw, head_px, head_py, head_pz;
    float left_qx, left_qy, left_qz, left_qw, left_px, left_py, left_pz;
    float right_qx, right_qy, right_qz, right_qw, right_px, right_py, right_pz;
    uint8_t btn_l, btn_r, trig_l, trig_r, grip_l, grip_r;
};
#pragma pack(pop)

class SteamVRNearsecController : public vr::ITrackedDeviceServerDriver {
public:
    SteamVRNearsecController(bool isRightHand) : m_bIsRightHand(isRightHand) {}

    virtual vr::EVRInitError Activate(uint32_t unObjectId) override {
        m_unObjectId = unObjectId;
        m_ulPropertyContainer = vr::VRProperties()->TrackedDeviceToPropertyContainer(m_unObjectId);

        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_ModelNumber_String, "NearsecVR_Controller");
        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_RenderModelName_String, "vr_controller_vive_1_5");
        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_InputProfilePath_String, "{nearsecvr}/input/nearsec_controller_profile.json");
        vr::VRProperties()->SetInt32Property(m_ulPropertyContainer, vr::Prop_ControllerRoleHint_Int32, m_bIsRightHand ? vr::TrackedControllerRole_RightHand : vr::TrackedControllerRole_LeftHand);
        vr::VRProperties()->SetInt32Property(m_ulPropertyContainer, vr::Prop_DeviceClass_Int32, vr::TrackedDeviceClass_Controller);

        vr::VRDriverInput()->CreateBooleanComponent(m_ulPropertyContainer, "/input/trigger/click", &m_compTriggerClick);
        vr::VRDriverInput()->CreateScalarComponent(m_ulPropertyContainer, "/input/trigger/value", &m_compTriggerValue, vr::VRScalarType_Absolute, vr::VRScalarUnits_NormalizedOneSided);
        vr::VRDriverInput()->CreateBooleanComponent(m_ulPropertyContainer, "/input/grip/click", &m_compGripClick);
        vr::VRDriverInput()->CreateBooleanComponent(m_ulPropertyContainer, "/input/a/click", &m_compA);
        vr::VRDriverInput()->CreateBooleanComponent(m_ulPropertyContainer, "/input/b/click", &m_compB);
        vr::VRDriverInput()->CreateBooleanComponent(m_ulPropertyContainer, "/input/system/click", &m_compSystem);

        return vr::VRInitError_None;
    }

    virtual void Deactivate() override {
        m_unObjectId = vr::k_unTrackedDeviceIndexInvalid;
    }
    
    virtual void EnterStandby() override {}
    virtual void* GetComponent(const char* pchComponentNameAndVersion) override { return nullptr; }
    virtual void DebugRequest(const char* pchRequest, char* pchResponseBuffer, uint32_t unResponseBufferSize) override {}

    virtual vr::DriverPose_t GetPose() override {
        vr::DriverPose_t pose = { 0 };
        pose.poseIsValid = true;
        pose.result = vr::TrackingResult_Running_OK;
        pose.deviceIsConnected = true;
        pose.qWorldFromDriverRotation = { 1, 0, 0, 0 };
        pose.qDriverFromHeadRotation = { 1, 0, 0, 0 };

        if (m_bIsRightHand) {
            pose.qRotation.x = m_state.right_qx; pose.qRotation.y = m_state.right_qy; pose.qRotation.z = m_state.right_qz; pose.qRotation.w = m_state.right_qw;
            pose.vecPosition[0] = m_state.right_px; pose.vecPosition[1] = m_state.right_py; pose.vecPosition[2] = m_state.right_pz;
        } else {
            pose.qRotation.x = m_state.left_qx; pose.qRotation.y = m_state.left_qy; pose.qRotation.z = m_state.left_qz; pose.qRotation.w = m_state.left_qw;
            pose.vecPosition[0] = m_state.left_px; pose.vecPosition[1] = m_state.left_py; pose.vecPosition[2] = m_state.left_pz;
        }
        return pose;
    }

    void UpdateState(const NearsecVRPacket& state) {
        if (m_unObjectId == vr::k_unTrackedDeviceIndexInvalid) return;
        m_state = state;
        vr::VRServerDriverHost()->TrackedDevicePoseUpdated(m_unObjectId, GetPose(), sizeof(vr::DriverPose_t));

        uint8_t btn = m_bIsRightHand ? state.btn_r : state.btn_l;
        uint8_t trig = m_bIsRightHand ? state.trig_r : state.trig_l;
        uint8_t grip = m_bIsRightHand ? state.grip_r : state.grip_l;

        vr::VRDriverInput()->UpdateBooleanComponent(m_compTriggerClick, trig > 128, 0);
        vr::VRDriverInput()->UpdateScalarComponent(m_compTriggerValue, trig / 255.0f, 0);
        vr::VRDriverInput()->UpdateBooleanComponent(m_compGripClick, grip > 128, 0);
        vr::VRDriverInput()->UpdateBooleanComponent(m_compA, (btn & 0x01) != 0, 0);
        vr::VRDriverInput()->UpdateBooleanComponent(m_compB, (btn & 0x02) != 0, 0);
        vr::VRDriverInput()->UpdateBooleanComponent(m_compSystem, (btn & 0x04) != 0, 0);
    }

private:
    bool m_bIsRightHand;
    vr::TrackedDeviceIndex_t m_unObjectId = vr::k_unTrackedDeviceIndexInvalid;
    vr::PropertyContainerHandle_t m_ulPropertyContainer = vr::k_ulInvalidPropertyContainer;
    NearsecVRPacket m_state = {0};

    vr::VRInputComponentHandle_t m_compTriggerClick = 0;
    vr::VRInputComponentHandle_t m_compTriggerValue = 0;
    vr::VRInputComponentHandle_t m_compGripClick = 0;
    vr::VRInputComponentHandle_t m_compA = 0;
    vr::VRInputComponentHandle_t m_compB = 0;
    vr::VRInputComponentHandle_t m_compSystem = 0;
};

class SteamVRNearcadeDriver : public vr::ITrackedDeviceServerDriver, public vr::IVRDisplayComponent {
public:
    SteamVRNearcadeDriver(SteamVRNearsecController* leftCtrl, SteamVRNearsecController* rightCtrl) 
        : m_pLeftController(leftCtrl), m_pRightController(rightCtrl) {}
    virtual vr::EVRInitError Activate(uint32_t unObjectId) override {
        m_unObjectId = unObjectId;
        m_ulPropertyContainer = vr::VRProperties()->TrackedDeviceToPropertyContainer(m_unObjectId);

        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_ModelNumber_String, "NearsecVR_HMD");
        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_RenderModelName_String, "generic_hmd");
        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_SerialNumber_String, "NEARCADE_VR_HMD");
        vr::VRProperties()->SetStringProperty(m_ulPropertyContainer, vr::Prop_ManufacturerName_String, "Fame");
        vr::VRProperties()->SetFloatProperty(m_ulPropertyContainer, vr::Prop_UserIpdMeters_Float, 0.063f);
        vr::VRProperties()->SetFloatProperty(m_ulPropertyContainer, vr::Prop_UserHeadToEyeDepthMeters_Float, 0.f);
        vr::VRProperties()->SetFloatProperty(m_ulPropertyContainer, vr::Prop_DisplayFrequency_Float, 90.0f);
        vr::VRProperties()->SetFloatProperty(m_ulPropertyContainer, vr::Prop_SecondsFromVsyncToPhotons_Float, 0.011f);
        vr::VRProperties()->SetBoolProperty(m_ulPropertyContainer, vr::Prop_IsOnDesktop_Bool, false);
        vr::VRProperties()->SetBoolProperty(m_ulPropertyContainer, vr::Prop_HasDisplayComponent_Bool, true);

        // Start UDP Listener Thread
        m_bIsRunning = true;
        m_pUdpThread = new std::thread(&SteamVRNearcadeDriver::UdpListenerThread, this);

        return vr::VRInitError_None;
    }

    virtual void Deactivate() override {
        m_bIsRunning = false;
        if (m_pUdpThread) {
            m_pUdpThread->join();
            delete m_pUdpThread;
            m_pUdpThread = nullptr;
        }
        m_unObjectId = vr::k_unTrackedDeviceIndexInvalid;
    }

    virtual void EnterStandby() override {}
    
    virtual void* GetComponent(const char* pchComponentNameAndVersion) override {
        if (strcmp(pchComponentNameAndVersion, vr::IVRDisplayComponent_Version) == 0) {
            return (vr::IVRDisplayComponent*)this;
        }
        return nullptr;
    }
    
    virtual void DebugRequest(const char* pchRequest, char* pchResponseBuffer, uint32_t unResponseBufferSize) override {}

    virtual vr::DriverPose_t GetPose() override {
        vr::DriverPose_t pose = { 0 };
        pose.poseIsValid = true;
        pose.result = vr::TrackingResult_Running_OK;
        pose.deviceIsConnected = true;

        pose.qWorldFromDriverRotation = { 1, 0, 0, 0 };
        pose.qDriverFromHeadRotation = { 1, 0, 0, 0 };
        
        // Apply latest UDP state
        pose.qRotation.x = m_latestState.head_qx;
        pose.qRotation.y = m_latestState.head_qy;
        pose.qRotation.z = m_latestState.head_qz;
        pose.qRotation.w = m_latestState.head_qw;
        
        pose.vecPosition[0] = m_latestState.head_px;
        pose.vecPosition[1] = m_latestState.head_py;
        pose.vecPosition[2] = m_latestState.head_pz;

        return pose;
    }

    // --- IVRDisplayComponent Implementation ---
    virtual void GetWindowBounds(int32_t* pnX, int32_t* pnY, uint32_t* pnWidth, uint32_t* pnHeight) override {
        *pnX = 0; *pnY = 0;
        *pnWidth = 1856 * 2; *pnHeight = 1856;
    }
    virtual bool IsDisplayOnDesktop() override { return true; }
    virtual bool IsDisplayRealDisplay() override { return false; }
    virtual void GetRecommendedRenderTargetSize(uint32_t* pnWidth, uint32_t* pnHeight) override {
        *pnWidth = 1856; *pnHeight = 1856;
    }
    virtual void GetEyeOutputViewport(vr::EVREye eEye, uint32_t* pnX, uint32_t* pnY, uint32_t* pnWidth, uint32_t* pnHeight) override {
        *pnY = 0;
        *pnWidth = 1856;
        *pnHeight = 1856;
        *pnX = (eEye == vr::Eye_Left) ? 0 : 1856;
    }
    virtual void GetProjectionRaw(vr::EVREye eEye, float* pfLeft, float* pfRight, float* pfTop, float* pfBottom) override {
        *pfLeft = -1.0; *pfRight = 1.0; *pfTop = -1.0; *pfBottom = 1.0;
    }
    virtual vr::DistortionCoordinates_t ComputeDistortion(vr::EVREye eEye, float fU, float fV) override {
        vr::DistortionCoordinates_t coordinates{};
        coordinates.rfBlue[0] = fU; coordinates.rfBlue[1] = fV;
        coordinates.rfGreen[0] = fU; coordinates.rfGreen[1] = fV;
        coordinates.rfRed[0] = fU; coordinates.rfRed[1] = fV;
        return coordinates;
    }
    
    virtual bool ComputeInverseDistortion(vr::HmdVector2_t* pResult, vr::EVREye eEye, uint32_t unChannel, float fU, float fV) override {
        return false;
    }

private:
    void UdpListenerThread() {
#ifdef _WIN32
        WSADATA wsaData;
        WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif
        int sock = socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in serverAddr;
        serverAddr.sin_family = AF_INET;
        serverAddr.sin_port = htons(27015);
        serverAddr.sin_addr.s_addr = INADDR_ANY;

        bind(sock, (struct sockaddr*)&serverAddr, sizeof(serverAddr));

        while (m_bIsRunning) {
            NearsecVRPacket packet;
            int bytesReceived = recv(sock, (char*)&packet, sizeof(packet), 0);
            if (bytesReceived == sizeof(NearsecVRPacket)) {
                m_latestState = packet;
                if (m_unObjectId != vr::k_unTrackedDeviceIndexInvalid) {
                    vr::VRServerDriverHost()->TrackedDevicePoseUpdated(m_unObjectId, GetPose(), sizeof(vr::DriverPose_t));
                }
                if (m_pLeftController) m_pLeftController->UpdateState(packet);
                if (m_pRightController) m_pRightController->UpdateState(packet);
            }
        }
#ifdef _WIN32
        closesocket(sock);
        WSACleanup();
#else
        close(sock);
#endif
    }

    vr::TrackedDeviceIndex_t m_unObjectId = vr::k_unTrackedDeviceIndexInvalid;
    vr::PropertyContainerHandle_t m_ulPropertyContainer = vr::k_ulInvalidPropertyContainer;
    std::thread* m_pUdpThread = nullptr;
    std::atomic<bool> m_bIsRunning{false};
    NearsecVRPacket m_latestState = {0};
    SteamVRNearsecController* m_pLeftController;
    SteamVRNearsecController* m_pRightController;
};

class NearsecServerProvider : public vr::IServerTrackedDeviceProvider {
public:
    virtual vr::EVRInitError Init(vr::IVRDriverContext* pDriverContext) override {
        VR_INIT_SERVER_DRIVER_CONTEXT(pDriverContext);
        
        m_pLeftCtrl = new SteamVRNearsecController(false);
        m_pRightCtrl = new SteamVRNearsecController(true);
        m_pHmd = new SteamVRNearcadeDriver(m_pLeftCtrl, m_pRightCtrl);
        
        vr::VRServerDriverHost()->TrackedDeviceAdded("nearsec_vrmd_1", vr::TrackedDeviceClass_HMD, m_pHmd);
        vr::VRServerDriverHost()->TrackedDeviceAdded("nearsec_vrctrl_left", vr::TrackedDeviceClass_Controller, m_pLeftCtrl);
        vr::VRServerDriverHost()->TrackedDeviceAdded("nearsec_vrctrl_right", vr::TrackedDeviceClass_Controller, m_pRightCtrl);
        
        return vr::VRInitError_None;
    }

    virtual void Cleanup() override {
        if (m_pHmd) { delete m_pHmd; m_pHmd = nullptr; }
        if (m_pLeftCtrl) { delete m_pLeftCtrl; m_pLeftCtrl = nullptr; }
        if (m_pRightCtrl) { delete m_pRightCtrl; m_pRightCtrl = nullptr; }
        VR_CLEANUP_SERVER_DRIVER_CONTEXT();
    }

    virtual const char* const* GetInterfaceVersions() override {
        return vr::k_InterfaceVersions;
    }

    virtual void RunFrame() override {}
    virtual bool ShouldBlockStandbyMode() override { return false; }
    virtual void EnterStandby() override {}
    virtual void LeaveStandby() override {}

private:
    SteamVRNearcadeDriver* m_pHmd = nullptr;
    SteamVRNearsecController* m_pLeftCtrl = nullptr;
    SteamVRNearsecController* m_pRightCtrl = nullptr;
};

NearsecServerProvider g_serverDriverProvider;

#if defined(_WIN32)
#define HMD_DLL_EXPORT extern "C" __declspec(dllexport)
#else
#define HMD_DLL_EXPORT extern "C" __attribute__((visibility("default")))
#endif

HMD_DLL_EXPORT void* HmdDriverFactory(const char* pInterfaceName, int* pReturnCode) {
    if (0 == strcmp(vr::IServerTrackedDeviceProvider_Version, pInterfaceName)) {
        return &g_serverDriverProvider;
    }
    if (pReturnCode) *pReturnCode = vr::VRInitError_Init_InterfaceNotFound;
    return nullptr;
}
