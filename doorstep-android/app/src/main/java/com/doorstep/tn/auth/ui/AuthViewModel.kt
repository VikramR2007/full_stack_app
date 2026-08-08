package com.doorstep.tn.auth.ui

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.doorstep.tn.auth.data.model.UserResponse
import com.doorstep.tn.auth.data.repository.AuthRepository
import com.doorstep.tn.auth.data.repository.Result
import com.doorstep.tn.core.datastore.PreferenceKeys
import com.doorstep.tn.core.datastore.dataStore
import com.doorstep.tn.core.security.SecureSessionStore
import com.doorstep.tn.core.security.SecureUserStore
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for authentication screens
 */
@HiltViewModel
class AuthViewModel @Inject constructor(
    private val authRepository: AuthRepository,
    @ApplicationContext private val context: Context
) : ViewModel() {
    
    // UI State
    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()
    
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()
    
    private val _isLoggedIn = MutableStateFlow(false)
    val isLoggedIn: StateFlow<Boolean> = _isLoggedIn.asStateFlow()

    private val _isAuthReady = MutableStateFlow(false)
    val isAuthReady: StateFlow<Boolean> = _isAuthReady.asStateFlow()
    
    private val _userRole = MutableStateFlow<String?>(null)
    val userRole: StateFlow<String?> = _userRole.asStateFlow()
    
    private val _userName = MutableStateFlow<String?>(null)
    val userName: StateFlow<String?> = _userName.asStateFlow()
    
    private val _currentUser = MutableStateFlow<UserResponse?>(null)
    val user: StateFlow<UserResponse?> = _currentUser.asStateFlow()

    private val _hasShopProfile = MutableStateFlow(false)
    val hasShopProfile: StateFlow<Boolean> = _hasShopProfile.asStateFlow()

    private val _hasProviderProfile = MutableStateFlow(false)
    val hasProviderProfile: StateFlow<Boolean> = _hasProviderProfile.asStateFlow()
    
    // Form State
    private val _phone = MutableStateFlow("")
    val phone: StateFlow<String> = _phone.asStateFlow()
    
    private val _otp = MutableStateFlow("")
    val otp: StateFlow<String> = _otp.asStateFlow()
    
    private val _pin = MutableStateFlow("")
    val pin: StateFlow<String> = _pin.asStateFlow()
    
    private val _confirmPin = MutableStateFlow("")
    val confirmPin: StateFlow<String> = _confirmPin.asStateFlow()
    
    private val _name = MutableStateFlow("")
    val name: StateFlow<String> = _name.asStateFlow()
    
    private val _selectedRole = MutableStateFlow("customer")
    val selectedRole: StateFlow<String> = _selectedRole.asStateFlow()
    
    private val _language = MutableStateFlow("en")
    val language: StateFlow<String> = _language.asStateFlow()
    
    // User exists check result
    private val _userExists = MutableStateFlow(false)
    val userExists: StateFlow<Boolean> = _userExists.asStateFlow()
    
    private val _existingUserName = MutableStateFlow<String?>(null)
    val existingUserName: StateFlow<String?> = _existingUserName.asStateFlow()
    
    init {
        // Check if user is already logged in
        viewModelScope.launch {
            try {
                val prefs = context.dataStore.data.first()
                val migrated = SecureUserStore.migrateFromDataStore(context, prefs)
                if (migrated) {
                    SecureUserStore.clearLegacyDataStore(context)
                }
                _isLoggedIn.value = prefs[PreferenceKeys.IS_LOGGED_IN] ?: false
                _userRole.value = SecureUserStore.getUserRole(context)
                _userName.value = SecureUserStore.getUserName(context)
                _language.value = prefs[PreferenceKeys.LANGUAGE] ?: "en"
                
                // Load last used phone number
                SecureUserStore.getLastPhone(context)?.let {
                    _phone.value = it
                }
                
                // If logged in, load user data from API
                if (_isLoggedIn.value) {
                    loadCurrentUser()
                }
            } finally {
                _isAuthReady.value = true
            }
        }
    }
    
    // Load current user data from API
    private fun loadCurrentUser() {
        viewModelScope.launch {
            when (val result = authRepository.getCurrentUser()) {
                is Result.Success -> {
                    val pendingRole = SecureUserStore.getPendingUserRole(context)
                    val effectiveRole = pendingRole ?: result.data.role

                    _currentUser.value = result.data.copy(role = effectiveRole)
                    _userName.value = result.data.name
                    _userRole.value = effectiveRole
                    SecureUserStore.setUserId(context, result.data.id.toString())
                    SecureUserStore.setUserName(context, result.data.name)
                    SecureUserStore.setUserRole(context, effectiveRole)
                    SecureUserStore.setUserPhone(context, result.data.phone)
                    _hasShopProfile.value = result.data.hasShopProfile == true
                    _hasProviderProfile.value = result.data.hasProviderProfile == true
                    if (pendingRole != null) {
                        if (pendingRole == result.data.role) {
                            SecureUserStore.setPendingUserRole(context, null)
                        } else {
                            when (authRepository.updateUserRole(result.data.id, pendingRole)) {
                                is Result.Success -> SecureUserStore.setPendingUserRole(context, null)
                                else -> {}
                            }
                        }
                    }
                }
                is Result.Error -> {
                    // Clear stale local session if backend marks this cookie/session invalid.
                    if (result.code == 401 || result.code == 403) {
                        clearLocalAuthState()
                        _error.value = "Session expired. Please log in again."
                    } else {
                        _error.value = result.message
                    }
                }
                is Result.Loading -> {}
            }
        }
    }
    
    // ==================== Form Updates ====================
    
    fun updatePhone(value: String) {
        _phone.value = value.filter { it.isDigit() }.take(10)
    }
    
    fun updateOtp(value: String) {
        _otp.value = value.filter { it.isDigit() }.take(6)
    }
    
    fun updatePin(value: String) {
        _pin.value = value.filter { it.isDigit() }.take(4)
    }
    
    fun updateConfirmPin(value: String) {
        _confirmPin.value = value.filter { it.isDigit() }.take(4)
    }
    
    fun updateName(value: String) {
        _name.value = value
    }
    
    fun updateSelectedRole(role: String) {
        _selectedRole.value = role
    }
    
    fun toggleLanguage() {
        // Cycle through languages: en -> ta -> en
        _language.value = when (_language.value) {
            "en" -> "ta"
            else -> "en"
        }
        viewModelScope.launch {
            context.dataStore.edit { prefs ->
                prefs[PreferenceKeys.LANGUAGE] = _language.value
            }
        }
    }
    
    /**
     * Set language directly (for dropdown selection)
     */
    fun setLanguage(languageCode: String) {
        _language.value = languageCode
        viewModelScope.launch {
            context.dataStore.edit { prefs ->
                prefs[PreferenceKeys.LANGUAGE] = languageCode
            }
        }
    }
    
    fun clearError() {
        _error.value = null
    }
    
    // ==================== Auth Actions ====================
    
    /**
     * Check if user exists by phone number
     * The activity parameter is retained to keep the existing Compose screen API stable.
     */
    fun checkUser(
        activity: android.app.Activity,
        onExistingUser: () -> Unit,
        onNewUser: () -> Unit
    ) {
        if (_phone.value.length != 10) {
            _error.value = "Please enter a valid 10-digit phone number"
            return
        }
        
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            
            // Save last phone
            SecureUserStore.setLastPhone(context, _phone.value)
            
            when (val result = authRepository.checkUser(_phone.value)) {
                is Result.Success -> {
                    _userExists.value = result.data.exists
                    _existingUserName.value = result.data.name
                    
                    _isLoading.value = false
                    if (result.data.exists) {
                        onExistingUser()
                    } else {
                        _error.value = "This mobile number is not configured for local sign-in. Add it to config/local-auth.json first."
                    }
                }
                is Result.Error -> {
                    _error.value = result.message
                    _isLoading.value = false
                }
                is Result.Loading -> {}
            }
        }
    }
    
    /**
     * Firebase/SMS is disabled for the local build. Configure the mobile number
     * and PIN in config/local-auth.json, then use the existing-user sign-in path.
     */
    fun sendOtpWithActivity(_activity: android.app.Activity, _onSuccess: () -> Unit) {
        _error.value = "SMS OTP is disabled. Use a mobile number and PIN configured by the app owner."
    }
    
    /**
     * Verify OTP entered by user
     */
    fun verifyOtp(onSuccess: () -> Unit) {
        if (_otp.value.length != 6) {
            _error.value = "Please enter a valid 6-digit OTP"
            return
        }
        
        _error.value = "SMS OTP is disabled in this build. Use the configured PIN to sign in."
    }
    
    /**
     * Login with PIN (existing user)
     */
    fun loginWithPin(onSuccess: (String) -> Unit) {
        if (_pin.value.length != 4) {
            _error.value = "Please enter a valid 4-digit PIN"
            return
        }
        
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            
            when (val result = authRepository.loginWithPin(_phone.value, _pin.value)) {
                is Result.Success -> {
                    saveUserSession(result.data)
                    onSuccess(result.data.role ?: "customer")
                }
                is Result.Error -> {
                    _error.value = result.message
                }
                is Result.Loading -> {}
            }
            
            _isLoading.value = false
        }
    }
    
    /**
     * Complete registration (new user)
     */
    fun completeRegistration(onSuccess: (String) -> Unit) {
        if (_pin.value.length != 4) {
            _error.value = "Please enter a valid 4-digit PIN"
            return
        }
        
        if (_pin.value != _confirmPin.value) {
            _error.value = "PINs do not match"
            return
        }
        
        if (_name.value.isBlank()) {
            _error.value = "Please enter your name"
            return
        }
        
        _error.value = "Self-registration is disabled. Add this user to config/local-auth.json, then sign in with its PIN."
    }
    
    /**
     * Logout user
     */
    fun logout() {
        viewModelScope.launch {
            authRepository.logout()
            SecureSessionStore.clearSession(context)
            SecureUserStore.clearUser(context)
            
            context.dataStore.edit { prefs ->
                prefs[PreferenceKeys.IS_LOGGED_IN] = false
                prefs.remove(PreferenceKeys.USER_ID)
                prefs.remove(PreferenceKeys.USER_NAME)
                prefs.remove(PreferenceKeys.USER_ROLE)
                prefs.remove(PreferenceKeys.USER_PHONE)
            }
            
            _isLoggedIn.value = false
            _userRole.value = null
            _userName.value = null
            _currentUser.value = null
            _hasShopProfile.value = false
            _hasProviderProfile.value = false
            
            // Clear form
            _pin.value = ""
            _confirmPin.value = ""
            _otp.value = ""
            _name.value = ""
        }
    }
    
    /**
     * Switch user role - updates backend and local storage
     */
    fun switchRole(newRole: String) {
        viewModelScope.launch {
            val userId = _currentUser.value?.id

            // Optimistically update local role for immediate navigation.
            SecureUserStore.setUserRole(context, newRole)
            _userRole.value = newRole
            _currentUser.value = _currentUser.value?.copy(role = newRole)

            if (userId == null) {
                SecureUserStore.setPendingUserRole(context, newRole)
                _error.value = "Role updated locally, but couldn't sync to server yet. We'll retry automatically."
                return@launch
            }

            when (val result = authRepository.updateUserRole(userId, newRole)) {
                is Result.Success -> SecureUserStore.setPendingUserRole(context, null)
                is Result.Error -> {
                    SecureUserStore.setPendingUserRole(context, newRole)
                    _error.value = "Couldn't sync role change. We'll retry automatically."
                }
                is Result.Loading -> {}
            }
        }
    }
    
    /**
     * Reset PIN after OTP verification
     */
    fun resetPin(onSuccess: () -> Unit) {
        if (_pin.value.length != 4) {
            _error.value = "Please enter a valid 4-digit PIN"
            return
        }
        
        if (_pin.value != _confirmPin.value) {
            _error.value = "PINs do not match"
            return
        }
        
        _error.value = "PIN resets are disabled. Change the PIN in config/local-auth.json and restart the server."
    }

    /**
     * Refresh profile availability for shop/provider switching
     */
    fun refreshProfiles() {
        viewModelScope.launch {
            when (val result = authRepository.getAuthProfiles()) {
                is Result.Success -> {
                    updateProfileFlags(
                        hasShop = result.data.hasShop,
                        hasProvider = result.data.hasProvider
                    )
                }
                is Result.Error -> {
                    _error.value = result.message
                }
                is Result.Loading -> {}
            }
        }
    }

    /**
     * Create shop profile and update local flags
     */
    fun createShopProfile(
        shopName: String,
        description: String?,
        onSuccess: () -> Unit,
        onError: (String) -> Unit
    ) {
        viewModelScope.launch {
            when (val result = authRepository.createShopProfile(shopName, description)) {
                is Result.Success -> {
                    updateProfileFlags(hasShop = true)
                    refreshProfiles()
                    onSuccess()
                }
                is Result.Error -> {
                    if (result.message.contains("already", ignoreCase = true)) {
                        updateProfileFlags(hasShop = true)
                        refreshProfiles()
                        onSuccess()
                    } else {
                        onError(result.message)
                    }
                }
                is Result.Loading -> {}
            }
        }
    }

    /**
     * Create provider profile and update local flags
     */
    fun createProviderProfile(
        bio: String?,
        onSuccess: () -> Unit,
        onError: (String) -> Unit
    ) {
        viewModelScope.launch {
            when (val result = authRepository.createProviderProfile(bio)) {
                is Result.Success -> {
                    updateProfileFlags(hasProvider = true)
                    refreshProfiles()
                    onSuccess()
                }
                is Result.Error -> {
                    if (result.message.contains("already", ignoreCase = true)) {
                        updateProfileFlags(hasProvider = true)
                        refreshProfiles()
                        onSuccess()
                    } else {
                        onError(result.message)
                    }
                }
                is Result.Loading -> {}
            }
        }
    }
    
    // ==================== Private Helpers ====================

    private suspend fun clearLocalAuthState() {
        SecureSessionStore.clearSession(context)
        SecureUserStore.clearUser(context)
        context.dataStore.edit { prefs ->
            prefs[PreferenceKeys.IS_LOGGED_IN] = false
            prefs.remove(PreferenceKeys.USER_ID)
            prefs.remove(PreferenceKeys.USER_NAME)
            prefs.remove(PreferenceKeys.USER_ROLE)
            prefs.remove(PreferenceKeys.USER_PHONE)
        }
        _isLoggedIn.value = false
        _userRole.value = null
        _userName.value = null
        _currentUser.value = null
        _hasShopProfile.value = false
        _hasProviderProfile.value = false
    }

    private suspend fun saveUserSession(user: UserResponse) {
        context.dataStore.edit { prefs ->
            prefs[PreferenceKeys.IS_LOGGED_IN] = true
            prefs.remove(PreferenceKeys.USER_ID)
            prefs.remove(PreferenceKeys.USER_NAME)
            prefs.remove(PreferenceKeys.USER_ROLE)
            prefs.remove(PreferenceKeys.USER_PHONE)
        }
        SecureUserStore.setUserId(context, user.id.toString())
        SecureUserStore.setUserName(context, user.name)
        SecureUserStore.setUserRole(context, user.role ?: "customer")
        SecureUserStore.setUserPhone(context, user.phone)
        
        _isLoggedIn.value = true
        _userRole.value = user.role
        _userName.value = user.name
        _currentUser.value = user
        _hasShopProfile.value = user.hasShopProfile == true
        _hasProviderProfile.value = user.hasProviderProfile == true
        
    }

    private fun updateProfileFlags(hasShop: Boolean? = null, hasProvider: Boolean? = null) {
        val current = _currentUser.value
        if (current != null) {
            _currentUser.value = current.copy(
                hasShopProfile = hasShop ?: current.hasShopProfile,
                hasProviderProfile = hasProvider ?: current.hasProviderProfile
            )
        }
        if (hasShop != null) {
            _hasShopProfile.value = hasShop
        }
        if (hasProvider != null) {
            _hasProviderProfile.value = hasProvider
        }
    }
    
}
