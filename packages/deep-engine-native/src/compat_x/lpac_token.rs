use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Security::*,
    System::{SystemServices::SE_GROUP_ENABLED, Threading::OpenProcessToken},
};

fn token_data(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<usize>> {
    if class == TokenIsAppContainer {
        let mut data = vec![0usize];
        let mut bytes = 0;
        if unsafe {
            GetTokenInformation(
                token,
                class,
                data.as_mut_ptr().cast(),
                size_of::<u32>() as u32,
                &mut bytes,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        return Ok(data);
    }
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut bytes);
    }
    if bytes == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut data = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token, class, data.as_mut_ptr().cast(), bytes, &mut bytes) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(data)
}
pub(super) fn verify_identity(process: HANDLE, expected_sid: PSID) -> io::Result<()> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let data = token_data(token.as_raw_handle(), TokenIsAppContainer)?;
    if unsafe { *data.as_ptr().cast::<u32>() } != 1 {
        return Err(io::Error::other("worker is not an AppContainer"));
    }
    let memberships = token_data(token.as_raw_handle(), TokenGroups)?;
    let groups_header = memberships.as_ptr().cast::<TOKEN_GROUPS>();
    let memberships = unsafe {
        std::slice::from_raw_parts(
            (*groups_header).Groups.as_ptr(),
            (*groups_header).GroupCount as usize,
        )
    };
    let mut package_sid = [0usize; 9];
    let mut sid_bytes = size_of_val(&package_sid) as u32;
    if unsafe {
        CreateWellKnownSid(
            WinBuiltinAnyPackageSid,
            std::ptr::null_mut(),
            package_sid.as_mut_ptr().cast(),
            &mut sid_bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if memberships.iter().any(|group| unsafe { EqualSid(group.Sid, package_sid.as_mut_ptr().cast()) } != 0 && group.Attributes & SE_GROUP_ENABLED as u32 != 0) {
        return Err(io::Error::other("worker retains ALL_APPLICATION_PACKAGES membership"));
    }
    let groups = token_data(token.as_raw_handle(), TokenCapabilities)
        .map_err(|e| io::Error::other(format!("token capabilities: {e}")))?;
    if unsafe { (*groups.as_ptr().cast::<TOKEN_GROUPS>()).GroupCount } != 0 {
        return Err(io::Error::other("worker has unexpected capabilities"));
    }
    let info = token_data(token.as_raw_handle(), TokenAppContainerSid)
        .map_err(|e| io::Error::other(format!("token app SID: {e}")))?;
    let actual_sid =
        unsafe { (*info.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>()).TokenAppContainer };
    if unsafe { EqualSid(actual_sid, expected_sid) } == 0 {
        return Err(io::Error::other("worker AppContainer SID mismatch"));
    }
    Ok(())
}
