import { describe, expect, it } from 'vitest'
import path from 'path'
import testQrCodes from '../test-assets/test-qr-codes.json'
import { decodeExportUri, buildOtpauthUri, decodeQRFromImage, loadAccountsFromJson, deduplicateAccounts, toBitwardenJson } from "./index.js"

describe("Protobuff decoding of QR export data", () => {

    it("Should decode single QR export", () => {
        const export1 = testQrCodes['Google-auth-test-qr.png']
        const actualAccounts = decodeExportUri(export1)

        expect(actualAccounts).toHaveLength(3)

        expect(actualAccounts[0]).toEqual({
            "algorithm": "SHA1",
            "digits": "SIX",
            "name": "Test account 1",
            "secret": "SGVsbA8h3q2+6A==",
            "totpSecret": "JBSWY3APEHPK3PXI",
            "type": "TOTP",
        })

        expect(actualAccounts[2]).toEqual({
            "algorithm": "SHA1",
            "counter": "1",
            "digits": "SIX",
            "name": "Counter key 1",
            "secret": "AESNbGQvO+MdHw==",
            "totpSecret": "ABCI23DEF456GHI7",
            "type": "HOTP",
        })
    })


    it("Should decode payload exported as 2 QR codes", () => {
        const export1 = testQrCodes['Google-auth-test2-qr1.png']
        const export2 = testQrCodes['Google-auth-test2-qr2.png']

        const actualAccounts1 = decodeExportUri(export1)
        const actualAccounts2 = decodeExportUri(export2)

        expect(actualAccounts1).toHaveLength(10)
        expect(actualAccounts2).toHaveLength(2)
    })

    it("Should decode export with SHA512 and 8 digit length code", () => {
        const export1 = testQrCodes['Google-auth-test-sha512-8digit.png']
        const actualAccounts = decodeExportUri(export1)

        expect(actualAccounts).toHaveLength(1)

        expect(actualAccounts[0]).toEqual({
            "algorithm": "SHA512",
            "digits": "EIGHT",
            "issuer": "TOTPgenerator",
            "name": "TOTPgenerator",
            "secret": "PWPBFOArrFMYoDSB1NZoYx5vGZM=",
            "totpSecret": "HVR4CFHAFOWFGGFAGSA5JVTIMMPG6GMT",
            "type": "TOTP"
        })
    })
})

describe("buildOtpauthUri", () => {

    it("Should build TOTP URI with default algorithm and digits", () => {
        const uri = buildOtpauthUri({
            name: "Test",
            issuer: "Example",
            totpSecret: "JBSWY3DPEHPK3PXP",
            algorithm: "SHA1",
            digits: "SIX",
            type: "TOTP",
        })

        expect(uri).toBe(
            "otpauth://totp/Example%3ATest?secret=JBSWY3DPEHPK3PXP&issuer=Example"
        )
    })

    it("Should build HOTP URI with counter", () => {
        const uri = buildOtpauthUri({
            name: "Counter key 1",
            totpSecret: "ABCI23DEF456GHI7",
            algorithm: "SHA1",
            digits: "SIX",
            type: "HOTP",
            counter: "1",
        })

        expect(uri).toBe(
            "otpauth://hotp/Counter%20key%201?secret=ABCI23DEF456GHI7&counter=1"
        )
    })

    it("Should include non-default algorithm and digits", () => {
        const uri = buildOtpauthUri({
            name: "TOTPgenerator",
            issuer: "TOTPgenerator",
            totpSecret: "HVR4CFHAFOWFGGFAGSA5JVTIMMPG6GMT",
            algorithm: "SHA512",
            digits: "EIGHT",
            type: "TOTP",
        })

        expect(uri).toContain("algorithm=SHA512")
        expect(uri).toContain("digits=8")
        expect(uri).toContain("secret=HVR4CFHAFOWFGGFAGSA5JVTIMMPG6GMT")
    })

    it("Should strip trailing padding from secret", () => {
        const uri = buildOtpauthUri({
            name: "Test",
            totpSecret: "JBSWY3DP====",
            algorithm: "SHA1",
            digits: "SIX",
            type: "TOTP",
        })

        expect(uri).toContain("secret=JBSWY3DP")
        expect(uri).not.toContain("====")
    })

    it("Should use name only as label when issuer is empty", () => {
        const uri = buildOtpauthUri({
            name: "myaccount@example.com",
            issuer: "",
            totpSecret: "JBSWY3DP",
            algorithm: "SHA1",
            digits: "SIX",
            type: "TOTP",
        })

        expect(uri.startsWith("otpauth://totp/myaccount%40example.com?")).toBe(true)
        expect(uri).not.toContain("issuer=")
    })
})

describe("QR image decoding", () => {

    it("Should decode accounts from a QR code image", async () => {
        const imagePath = path.join(__dirname, "../test-assets/test-qr-image.png")
        const uri = await decodeQRFromImage(imagePath)

        expect(uri).toContain("otpauth-migration://")

        const accounts = decodeExportUri(uri)
        expect(accounts).toHaveLength(3)
        expect(accounts[0].name).toBe("Test account 1")
    })

    it("Should throw for image with no QR code", async () => {
        const blankPath = path.join(__dirname, "../test-assets/blank.png")
        await expect(decodeQRFromImage(blankPath)).rejects.toThrow("No QR code found")
    })
})

describe("loadAccountsFromJson", () => {

    it("Should load accounts from exported JSON file", () => {
        const jsonPath = path.join(__dirname, "../test-assets/test-accounts.json")
        const accounts = loadAccountsFromJson(jsonPath)

        expect(accounts).toHaveLength(3)
        expect(accounts[0].name).toBe("Test account 1")
        expect(accounts[0].totpSecret).toBe("JBSWY3APEHPK3PXI")
    })

    it("Should throw for non-existent file", () => {
        expect(() => loadAccountsFromJson("/no/such/file.json")).toThrow("File not found")
    })

    it("Should throw for JSON missing totpSecret", () => {
        const badPath = path.join(__dirname, "../test-assets/test-qr-codes.json")
        expect(() => loadAccountsFromJson(badPath)).toThrow("missing 'totpSecret'")
    })
})

describe("deduplicateAccounts", () => {

    it("Should remove duplicate accounts", () => {
        const account = {
            name: "Test", issuer: "Example", totpSecret: "JBSWY3DP",
            algorithm: "SHA1", digits: "SIX", type: "TOTP",
        }
        const result = deduplicateAccounts([account, { ...account }, { ...account }])
        expect(result).toHaveLength(1)
    })

    it("Should keep accounts with different secrets", () => {
        const base = { name: "Test", issuer: "Example", algorithm: "SHA1", digits: "SIX", type: "TOTP" }
        const result = deduplicateAccounts([
            { ...base, totpSecret: "AAA" },
            { ...base, totpSecret: "BBB" },
        ])
        expect(result).toHaveLength(2)
    })

    it("Should keep accounts with different names", () => {
        const base = { issuer: "Example", totpSecret: "AAA", algorithm: "SHA1", digits: "SIX", type: "TOTP" }
        const result = deduplicateAccounts([
            { ...base, name: "account1" },
            { ...base, name: "account2" },
        ])
        expect(result).toHaveLength(2)
    })

    it("Should deduplicate across two decoded batches", () => {
        const export1 = testQrCodes['Google-auth-test-qr.png']
        const accounts1 = decodeExportUri(export1)
        const accounts2 = decodeExportUri(export1)
        const result = deduplicateAccounts([...accounts1, ...accounts2])
        expect(result).toHaveLength(accounts1.length)
    })
})

describe("toBitwardenJson", () => {

    it("Should produce valid Bitwarden import structure", () => {
        const accounts = [{
            name: "user@example.com",
            issuer: "GitHub",
            totpSecret: "JBSWY3DP",
            algorithm: "SHA1",
            digits: "SIX",
            type: "TOTP",
        }]

        const result = toBitwardenJson(accounts)

        expect(result.encrypted).toBe(false)
        expect(result.folders).toEqual([])
        expect(result.items).toHaveLength(1)

        const item = result.items[0]
        expect(item.type).toBe(1)
        expect(item.name).toBe("GitHub")
        expect(item.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(item.folderId).toBeNull()
        expect(item.organizationId).toBeNull()
        expect(item.collectionIds).toBeNull()
        expect(item.notes).toBeNull()
        expect(item.deletedDate).toBeNull()
        expect(item.revisionDate).toBeTruthy()
        expect(item.creationDate).toBeTruthy()
        expect(item.login.username).toBe("user@example.com")
        expect(item.login.password).toBeNull()
        expect(item.login.uris).toEqual([])
        expect(item.login.fido2Credentials).toEqual([])
        expect(item.login.totp).toContain("otpauth://totp/")
        expect(item.login.totp).toContain("secret=JBSWY3DP")
    })

    it("Should use name as item name when issuer is empty", () => {
        const accounts = [{
            name: "My Account",
            totpSecret: "JBSWY3DP",
            algorithm: "SHA1",
            digits: "SIX",
            type: "TOTP",
        }]

        const result = toBitwardenJson(accounts)
        expect(result.items[0].name).toBe("My Account")
    })

    it("Should convert real decoded accounts", () => {
        const export1 = testQrCodes['Google-auth-test-qr.png']
        const accounts = decodeExportUri(export1)
        const result = toBitwardenJson(accounts)

        expect(result.items).toHaveLength(3)
        result.items.forEach(item => {
            expect(item.type).toBe(1)
            expect(item.login.totp).toMatch(/^otpauth:\/\//)
        })
    })
})
